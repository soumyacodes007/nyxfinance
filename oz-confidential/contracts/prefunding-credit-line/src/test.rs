#![cfg(test)]

// Contract-level integration tests for the credit line, wired to lightweight
// mock cross-contract dependencies (participant policy, collateral policy,
// oracle, lock registry, verifier, confidential token) instead of the real
// deployed contracts. Circuit soundness is covered separately by
// `circuits/collateral_sufficiency`'s `nargo test` suite; these tests cover
// the piece that suite cannot see: how the credit line's own state machine
// (open -> draw -> repay / liquidate, pause, roles, replay/lock guards)
// behaves when wired to real cross-contract calls inside a Soroban `Env`.

use crate::{
    CollateralPolicyData, ConfidentialAccountData, CreditLineError, OraclePriceData,
    PrefundingCreditLineContract, PrefundingCreditLineContractClient,
};
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger, LedgerInfo},
    Address, Bytes, BytesN, Env, Symbol,
};

const LEDGERS_PER_DAY: u32 = 17_280;

// ---- Mock cross-contract dependencies ----

#[contract]
struct MockParticipantPolicy;

#[contractimpl]
impl MockParticipantPolicy {
    pub fn __constructor(e: Env, approved: Address) {
        e.storage().instance().set(&symbol_short!("appr"), &approved);
    }

    pub fn is_approved(e: Env, anchor: Address) -> bool {
        e.storage()
            .instance()
            .get::<_, Address>(&symbol_short!("appr"))
            .map(|a| a == anchor)
            .unwrap_or(false)
    }
}

#[contract]
struct MockCollateralPolicy;

#[contractimpl]
impl MockCollateralPolicy {
    pub fn __constructor(e: Env, policy: CollateralPolicyData) {
        e.storage().instance().set(&symbol_short!("policy"), &policy);
    }

    pub fn policy(e: Env, _token: Address) -> CollateralPolicyData {
        e.storage().instance().get(&symbol_short!("policy")).unwrap()
    }
}

#[contract]
struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn __constructor(e: Env, data: OraclePriceData) {
        e.storage().instance().set(&symbol_short!("price"), &data);
    }

    pub fn price(e: Env, _token: Address) -> OraclePriceData {
        e.storage().instance().get(&symbol_short!("price")).unwrap()
    }
}

#[contract]
struct MockLockRegistry;

#[contractimpl]
impl MockLockRegistry {
    #[allow(clippy::too_many_arguments)]
    pub fn lock(
        e: Env,
        lock_key: BytesN<32>,
        _owner: Address,
        _collateral_token: Address,
        _position_id: BytesN<32>,
        _tenor_days: u32,
        _operator: Address,
    ) {
        let key = (symbol_short!("lock"), lock_key);
        if e.storage().persistent().get::<_, bool>(&key).unwrap_or(false) {
            panic!("already locked");
        }
        e.storage().persistent().set(&key, &true);
    }

    pub fn release(e: Env, lock_key: BytesN<32>, _operator: Address) {
        e.storage().persistent().set(&(symbol_short!("lock"), lock_key), &false);
    }

    pub fn is_locked(e: Env, lock_key: BytesN<32>) -> bool {
        e.storage()
            .persistent()
            .get(&(symbol_short!("lock"), lock_key))
            .unwrap_or(false)
    }
}

#[contract]
struct MockVerifier;

#[contractimpl]
impl MockVerifier {
    pub fn __constructor(e: Env, should_pass: bool) {
        e.storage().instance().set(&symbol_short!("pass"), &should_pass);
    }

    pub fn verify_proof(e: Env, _public_inputs: Bytes, _proof: Bytes) -> bool {
        e.storage().instance().get(&symbol_short!("pass")).unwrap_or(false)
    }
}

#[contract]
struct MockConfidentialToken;

#[contractimpl]
impl MockConfidentialToken {
    pub fn __constructor(e: Env, account: Address, data: ConfidentialAccountData) {
        e.storage()
            .instance()
            .set(&(symbol_short!("acct"), account), &data);
    }

    pub fn confidential_balance(e: Env, account: Address) -> ConfidentialAccountData {
        e.storage()
            .instance()
            .get(&(symbol_short!("acct"), account))
            .unwrap()
    }

    pub fn freeze(e: Env, account: Address, _operator: Address) {
        e.storage().instance().set(&(symbol_short!("frz"), account), &true);
    }

    pub fn unfreeze(e: Env, account: Address, _operator: Address) {
        e.storage().instance().set(&(symbol_short!("frz"), account), &false);
    }

    pub fn is_frozen(e: Env, account: Address) -> bool {
        e.storage()
            .instance()
            .get(&(symbol_short!("frz"), account))
            .unwrap_or(false)
    }
}

#[contract]
struct MockCreditToken;

#[contractimpl]
impl MockCreditToken {
    pub fn __constructor(e: Env, should_fail: bool) {
        e.storage().instance().set(&symbol_short!("fail"), &should_fail);
        e.storage().instance().set(&symbol_short!("calls"), &0u32);
    }

    // Mirrors `ConfidentialToken::confidential_transfer_from`'s auth shape:
    // the spender (the credit-line contract, calling as itself) must
    // authorize. Panics if configured to simulate an invalid/rejected proof.
    pub fn confidential_transfer_from(e: Env, spender: Address, _from: Address, _to: Address, _data: Bytes) {
        spender.require_auth();
        if e.storage().instance().get::<_, bool>(&symbol_short!("fail")).unwrap_or(false) {
            panic!("InvalidProof");
        }
        let calls: u32 = e.storage().instance().get(&symbol_short!("calls")).unwrap_or(0);
        e.storage().instance().set(&symbol_short!("calls"), &(calls + 1));
    }

    // Mirrors `ConfidentialToken::confidential_transfer`'s auth shape: the
    // `from` (the anchor, repaying) must authorize.
    pub fn confidential_transfer(e: Env, from: Address, _to: Address, _data: Bytes) {
        from.require_auth();
        if e.storage().instance().get::<_, bool>(&symbol_short!("fail")).unwrap_or(false) {
            panic!("InvalidProof");
        }
        let calls: u32 = e.storage().instance().get(&symbol_short!("calls")).unwrap_or(0);
        e.storage().instance().set(&symbol_short!("calls"), &(calls + 1));
    }

    pub fn calls(e: Env) -> u32 {
        e.storage().instance().get(&symbol_short!("calls")).unwrap_or(0)
    }
}

// ---- Test harness ----

struct Harness {
    env: Env,
    client: PrefundingCreditLineContractClient<'static>,
    admin: Address,
    manager: Address,
    anchor: Address,
    collateral_token: Address,
    credit_token: Address,
    c_spend_x: BytesN<32>,
    c_spend_y: BytesN<32>,
    y_x: BytesN<32>,
    y_y: BytesN<32>,
    credit_commitment_x: BytesN<32>,
    credit_commitment_y: BytesN<32>,
    oracle_price_e7: u128,
    haircut_bps: u32,
}

fn bytesn32(e: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(e, &[byte; 32])
}

fn bytesn64(e: &Env, byte: u8) -> BytesN<64> {
    BytesN::from_array(e, &[byte; 64])
}

fn setup(verifier_passes: bool) -> Harness {
    setup_with_credit_token(verifier_passes, false)
}

fn setup_with_credit_token(verifier_passes: bool, credit_transfer_fails: bool) -> Harness {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set(LedgerInfo {
        timestamp: 0,
        // soroban-sdk's major version tracks the protocol version (SDK 26 -> Protocol 26).
        protocol_version: 26,
        sequence_number: 1_000,
        network_id: [0; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 16 * LEDGERS_PER_DAY,
        min_persistent_entry_ttl: 16 * LEDGERS_PER_DAY,
        max_entry_ttl: 365 * LEDGERS_PER_DAY,
    });

    let admin = Address::generate(&env);
    let manager = Address::generate(&env);
    let anchor = Address::generate(&env);

    let c_spend_x = bytesn32(&env, 0x11);
    let c_spend_y = bytesn32(&env, 0x12);
    let y_x = bytesn32(&env, 0x21);
    let y_y = bytesn32(&env, 0x22);
    let credit_commitment_x = bytesn32(&env, 0x31);
    let credit_commitment_y = bytesn32(&env, 0x32);

    let mut spending_key = [0u8; 64];
    spending_key[..32].copy_from_slice(&y_x.to_array());
    spending_key[32..].copy_from_slice(&y_y.to_array());
    let mut spendable_balance = [0u8; 64];
    spendable_balance[..32].copy_from_slice(&c_spend_x.to_array());
    spendable_balance[32..].copy_from_slice(&c_spend_y.to_array());

    let account_data = ConfidentialAccountData {
        spending_key: BytesN::from_array(&env, &spending_key),
        viewing_public_key: bytesn64(&env, 0x00),
        spendable_balance: BytesN::from_array(&env, &spendable_balance),
        receiving_balance: bytesn64(&env, 0x00),
        auditor_id: 1,
    };
    let collateral_token = env.register(MockConfidentialToken, (anchor.clone(), account_data));

    let oracle_price_e7 = 10_000_000u128;
    let haircut_bps = 500u32;
    let oracle = env.register(
        MockOracle,
        (OraclePriceData {
            price_e7: oracle_price_e7 as i128,
            updated_ledger: 1_000,
        },),
    );
    let collateral_policy = env.register(
        MockCollateralPolicy,
        (CollateralPolicyData {
            eligible: true,
            haircut_bps,
            max_tenor_days: 5,
            oracle: oracle.clone(),
            max_staleness_ledgers: 1_000,
        },),
    );
    let participant_policy = env.register(MockParticipantPolicy, (anchor.clone(),));
    let lock_registry = env.register(MockLockRegistry, ());
    let verifier = env.register(MockVerifier, (verifier_passes,));
    let credit_token = env.register(MockCreditToken, (credit_transfer_fails,));

    let credit_line = env.register(
        PrefundingCreditLineContract,
        (
            admin.clone(),
            manager.clone(),
            participant_policy,
            collateral_policy,
            lock_registry,
            verifier,
            credit_token.clone(),
        ),
    );
    let client = PrefundingCreditLineContractClient::new(&env, &credit_line);

    Harness {
        env,
        client,
        admin,
        manager,
        anchor,
        collateral_token,
        credit_token,
        c_spend_x,
        c_spend_y,
        y_x,
        y_y,
        credit_commitment_x,
        credit_commitment_y,
        oracle_price_e7,
        haircut_bps,
    }
}

impl Harness {
    fn public_inputs(&self, lock_key: &BytesN<32>, tenor_days: u32, position_nullifier: &BytesN<32>) -> Bytes {
        PrefundingCreditLineContract::public_inputs(
            &self.env,
            self.c_spend_x.clone(),
            self.c_spend_y.clone(),
            self.y_x.clone(),
            self.y_y.clone(),
            self.credit_commitment_x.clone(),
            self.credit_commitment_y.clone(),
            self.oracle_price_e7,
            self.haircut_bps,
            tenor_days,
            lock_key.clone(),
            position_nullifier.clone(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn open(
        &self,
        position_id: &BytesN<32>,
        lock_key: &BytesN<32>,
        tenor_days: u32,
        position_nullifier: &BytesN<32>,
        proof: Bytes,
    ) -> BytesN<32> {
        let public_inputs = self.public_inputs(lock_key, tenor_days, position_nullifier);
        self.client.open_credit(
            position_id,
            &self.anchor,
            &self.collateral_token,
            lock_key,
            &self.credit_commitment_x,
            &self.credit_commitment_y,
            &self.oracle_price_e7,
            &self.haircut_bps,
            &tenor_days,
            position_nullifier,
            &public_inputs,
            &proof,
            &self.manager,
        )
    }
}

fn dummy_proof(e: &Env) -> Bytes {
    Bytes::from_array(e, &[0xAB; 8])
}

fn dummy_transfer_data(e: &Env) -> Bytes {
    Bytes::from_array(e, &[0xCD; 8])
}

// ---- Happy path: open -> draw -> repay ----

#[test]
fn open_draw_repay_happy_path() {
    let h = setup(true);
    let position_id = bytesn32(&h.env, 0xA1);
    let lock_key = bytesn32(&h.env, 0xA2);
    let nullifier = bytesn32(&h.env, 0xA3);

    h.open(&position_id, &lock_key, 3, &nullifier, dummy_proof(&h.env));

    // F2: opening freezes the anchor's confidential collateral account.
    let token_client = MockConfidentialTokenClient::new(&h.env, &h.collateral_token);
    assert!(token_client.is_frozen(&h.anchor));

    let position = h.client.position(&position_id);
    assert!(position.open);
    assert!(!position.drawn);
    assert!(!position.defaulted);

    let facility = Address::generate(&h.env);
    let credit_executor = Address::generate(&h.env);
    h.client.execute_draw(
        &position_id,
        &facility,
        &credit_executor,
        &h.credit_commitment_x,
        &h.credit_commitment_y,
        &dummy_transfer_data(&h.env),
        &h.manager,
    );
    let drawn = h.client.position(&position_id);
    assert!(drawn.drawn);

    // The draw's confidential_transfer_from was actually invoked on the
    // credit token, atomically with marking the position drawn -- not just
    // a commitment-equality check with a separately-submitted transfer.
    let credit_token_client = MockCreditTokenClient::new(&h.env, &h.credit_token);
    assert_eq!(credit_token_client.calls(), 1);

    let repayment_commitment = bytesn32(&h.env, 0xB1);
    h.client.repay(
        &position_id,
        &facility,
        &repayment_commitment,
        &dummy_transfer_data(&h.env),
        &h.manager,
    );
    let repaid = h.client.position(&position_id);
    assert!(!repaid.open);

    // The repayment's confidential_transfer was actually invoked too.
    assert_eq!(credit_token_client.calls(), 2);

    // F2: repay unfreezes the collateral account.
    assert!(!token_client.is_frozen(&h.anchor));
}

// ---- New: execute_draw must actually move real value, not just check the
// commitment matches -- if the credit-token transfer fails/reverts, the whole
// draw (including marking the position as drawn) must revert with it. ----

#[test]
fn execute_draw_reverts_if_transfer_fails() {
    let h = setup_with_credit_token(true, true);
    let position_id = bytesn32(&h.env, 0x31);
    let lock_key = bytesn32(&h.env, 0x32);
    let nullifier = bytesn32(&h.env, 0x33);
    h.open(&position_id, &lock_key, 3, &nullifier, dummy_proof(&h.env));

    let facility = Address::generate(&h.env);
    let credit_executor = Address::generate(&h.env);
    let result = h.client.try_execute_draw(
        &position_id,
        &facility,
        &credit_executor,
        &h.credit_commitment_x,
        &h.credit_commitment_y,
        &dummy_transfer_data(&h.env),
        &h.manager,
    );
    assert!(result.is_err());

    // The whole transaction reverted: the position must still show undrawn.
    let position = h.client.position(&position_id);
    assert!(!position.drawn);
}

// ---- New: repay must actually move real value -- if the credit-token
// transfer fails, the position must stay open and the collateral must stay
// frozen (not unfrozen on the operator's word alone). ----

#[test]
fn repay_reverts_if_transfer_fails_and_keeps_collateral_frozen() {
    let h = setup_with_credit_token(true, true);
    let position_id = bytesn32(&h.env, 0x41);
    let lock_key = bytesn32(&h.env, 0x42);
    let nullifier = bytesn32(&h.env, 0x43);
    h.open(&position_id, &lock_key, 3, &nullifier, dummy_proof(&h.env));

    let facility = Address::generate(&h.env);
    let repayment_commitment = bytesn32(&h.env, 0x44);
    let result = h.client.try_repay(
        &position_id,
        &facility,
        &repayment_commitment,
        &dummy_transfer_data(&h.env),
        &h.manager,
    );
    assert!(result.is_err());

    let position = h.client.position(&position_id);
    assert!(position.open);

    let token_client = MockConfidentialTokenClient::new(&h.env, &h.collateral_token);
    assert!(token_client.is_frozen(&h.anchor));
}

// ---- K2: draw amount must equal the proven credit commitment ----

#[test]
fn execute_draw_rejects_mismatched_commitment() {
    let h = setup(true);
    let position_id = bytesn32(&h.env, 0xC1);
    let lock_key = bytesn32(&h.env, 0xC2);
    let nullifier = bytesn32(&h.env, 0xC3);
    h.open(&position_id, &lock_key, 3, &nullifier, dummy_proof(&h.env));

    let facility = Address::generate(&h.env);
    let credit_executor = Address::generate(&h.env);
    let wrong_commitment_x = bytesn32(&h.env, 0xFF);
    let result = h.client.try_execute_draw(
        &position_id,
        &facility,
        &credit_executor,
        &wrong_commitment_x,
        &h.credit_commitment_y,
        &dummy_transfer_data(&h.env),
        &h.manager,
    );
    assert_eq!(
        result,
        Err(Ok(soroban_sdk::Error::from_contract_error(
            CreditLineError::DrawCommitmentMismatch as u32
        )))
    );
}

// ---- Proof verification failure ----

#[test]
fn open_credit_rejects_failing_proof() {
    let h = setup(false);
    let position_id = bytesn32(&h.env, 0xD1);
    let lock_key = bytesn32(&h.env, 0xD2);
    let nullifier = bytesn32(&h.env, 0xD3);
    let public_inputs = h.public_inputs(&lock_key, 3, &nullifier);
    let result = h.client.try_open_credit(
        &position_id,
        &h.anchor,
        &h.collateral_token,
        &lock_key,
        &h.credit_commitment_x,
        &h.credit_commitment_y,
        &h.oracle_price_e7,
        &h.haircut_bps,
        &3u32,
        &nullifier,
        &public_inputs,
        &dummy_proof(&h.env),
        &h.manager,
    );
    assert_eq!(
        result,
        Err(Ok(soroban_sdk::Error::from_contract_error(
            CreditLineError::ProofVerificationFailed as u32
        )))
    );
}

// ---- K1: same lock cannot be reused while active ----

#[test]
fn reusing_active_lock_key_fails() {
    let h = setup(true);
    let position_id_1 = bytesn32(&h.env, 0xE1);
    let position_id_2 = bytesn32(&h.env, 0xE2);
    let lock_key = bytesn32(&h.env, 0xE3);
    let nullifier_1 = bytesn32(&h.env, 0xE4);
    let nullifier_2 = bytesn32(&h.env, 0xE5);

    h.open(&position_id_1, &lock_key, 3, &nullifier_1, dummy_proof(&h.env));

    let public_inputs_2 = h.public_inputs(&lock_key, 3, &nullifier_2);
    let result = h.client.try_open_credit(
        &position_id_2,
        &h.anchor,
        &h.collateral_token,
        &lock_key,
        &h.credit_commitment_x,
        &h.credit_commitment_y,
        &h.oracle_price_e7,
        &h.haircut_bps,
        &3u32,
        &nullifier_2,
        &public_inputs_2,
        &dummy_proof(&h.env),
        &h.manager,
    );
    assert_eq!(
        result,
        Err(Ok(soroban_sdk::Error::from_contract_error(
            CreditLineError::LockAlreadyUsed as u32
        )))
    );
}

// ---- Pause blocks new opens ----

#[test]
fn paused_blocks_open_credit() {
    let h = setup(true);
    h.client.pause();
    let position_id = bytesn32(&h.env, 0xF1);
    let lock_key = bytesn32(&h.env, 0xF2);
    let nullifier = bytesn32(&h.env, 0xF3);
    let public_inputs = h.public_inputs(&lock_key, 3, &nullifier);
    let result = h.client.try_open_credit(
        &position_id,
        &h.anchor,
        &h.collateral_token,
        &lock_key,
        &h.credit_commitment_x,
        &h.credit_commitment_y,
        &h.oracle_price_e7,
        &h.haircut_bps,
        &3u32,
        &nullifier,
        &public_inputs,
        &dummy_proof(&h.env),
        &h.manager,
    );
    assert_eq!(
        result,
        Err(Ok(soroban_sdk::Error::from_contract_error(CreditLineError::Paused as u32)))
    );
}

// ---- F2 default path: liquidate after due ledger, blocked before ----

#[test]
fn liquidate_before_due_ledger_fails() {
    let h = setup(true);
    let position_id = bytesn32(&h.env, 0x11);
    let lock_key = bytesn32(&h.env, 0x12);
    let nullifier = bytesn32(&h.env, 0x13);
    h.open(&position_id, &lock_key, 3, &nullifier, dummy_proof(&h.env));

    h.client.grant_role(&h.admin, &Symbol::new(&h.env, "liquidator"), &h.admin);
    let result = h.client.try_liquidate(&position_id, &h.admin);
    assert_eq!(
        result,
        Err(Ok(soroban_sdk::Error::from_contract_error(CreditLineError::NotYetDue as u32)))
    );
}

#[test]
fn liquidate_after_due_ledger_seizes_and_blocks_repay() {
    let h = setup(true);
    let position_id = bytesn32(&h.env, 0x21);
    let lock_key = bytesn32(&h.env, 0x22);
    let nullifier = bytesn32(&h.env, 0x23);
    h.open(&position_id, &lock_key, 3, &nullifier, dummy_proof(&h.env));

    // Fast-forward past the 3-day tenor without waiting in real time.
    let mut info = h.env.ledger().get();
    info.sequence_number += 3 * LEDGERS_PER_DAY + 1;
    h.env.ledger().set(info);

    h.client.grant_role(&h.admin, &Symbol::new(&h.env, "liquidator"), &h.admin);
    h.client.liquidate(&position_id, &h.admin);

    let position = h.client.position(&position_id);
    assert!(position.defaulted);

    // Collateral stays frozen after seizure -- the anchor cannot reclaim it.
    let token_client = MockConfidentialTokenClient::new(&h.env, &h.collateral_token);
    assert!(token_client.is_frozen(&h.anchor));

    // A defaulted position can no longer be repaid.
    let facility = Address::generate(&h.env);
    let repayment_commitment = bytesn32(&h.env, 0x24);
    let result = h.client.try_repay(
        &position_id,
        &facility,
        &repayment_commitment,
        &dummy_transfer_data(&h.env),
        &h.manager,
    );
    assert_eq!(
        result,
        Err(Ok(soroban_sdk::Error::from_contract_error(
            CreditLineError::PositionDefaulted as u32
        )))
    );
}
