#![no_std]

#[cfg(test)]
mod test;

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::upgradeable;
use stellar_macros::{only_admin, only_role};

const MANAGER_ROLE: Symbol = symbol_short!("manager");
const LEDGERS_PER_DAY: u32 = 17_280;
// Persistent replay/position state must outlive the maximum tenor (5 days) with
// generous headroom so the nullifier guard and position are never archived while
// a credit line is live.
const STATE_TTL_THRESHOLD: u32 = LEDGERS_PER_DAY * 7;
const STATE_TTL_EXTEND_TO: u32 = LEDGERS_PER_DAY * 60;

// Local mirrors of the registry/oracle return types. Cross-contract structs are
// decoded by field name, so these must match `CollateralPolicyRegistry::policy`
// and `OracleAdapter::price` field-for-field. Fetching the whole struct once
// replaces five (policy) and two (oracle) separate cross-contract calls.
#[contracttype]
#[derive(Clone)]
pub struct CollateralPolicyData {
    pub eligible: bool,
    pub haircut_bps: u32,
    pub max_tenor_days: u32,
    pub oracle: Address,
    pub max_staleness_ledgers: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct OraclePriceData {
    pub price_e7: i128,
    pub updated_ledger: u32,
}

// Mirror of `stellar_tokens::confidential::ConfidentialAccount`, decoded by field
// name from the confidential token's `confidential_balance` getter. Points are
// Grumpkin affine coordinates packed as `x || y` (32 bytes each).
#[contracttype]
#[derive(Clone)]
pub struct ConfidentialAccountData {
    pub spending_key: BytesN<64>,
    pub viewing_public_key: BytesN<64>,
    pub spendable_balance: BytesN<64>,
    pub receiving_balance: BytesN<64>,
    pub auditor_id: u32,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum CreditLineError {
    ParticipantNotApproved = 4501,
    CollateralIneligible = 4502,
    TenorTooLong = 4503,
    StaleOraclePrice = 4504,
    ProofNotApproved = 4505,
    LockAlreadyUsed = 4506,
    PositionAlreadyExists = 4507,
    PositionNotFound = 4508,
    PositionNotOpen = 4509,
    InvalidAmount = 4510,
    ProofVerificationFailed = 4511,
    PublicInputsMismatch = 4512,
    NullifierAlreadyUsed = 4513,
    PositionAlreadyDrawn = 4514,
    PositionDefaulted = 4515,
    NotYetDue = 4516,
    DrawCommitmentMismatch = 4517,
    Paused = 4518,
    CollateralNotLocked = 4519,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreditPosition {
    pub open: bool,
    pub drawn: bool,
    pub anchor: Address,
    pub collateral_token: Address,
    pub lock_key: BytesN<32>,
    pub collateral_commitment_x: BytesN<32>,
    pub collateral_commitment_y: BytesN<32>,
    pub credit_commitment_x: BytesN<32>,
    pub credit_commitment_y: BytesN<32>,
    pub position_nullifier: BytesN<32>,
    pub tenor_days: u32,
    pub opened_ledger: u32,
    pub due_ledger: u32,
    pub proof_verified: bool,
    pub defaulted: bool,
}

#[contractevent(topics = ["CreditOpened"])]
pub struct CreditOpened {
    pub position_id: BytesN<32>,
    pub anchor: Address,
    pub collateral_asset: Address,
    pub tenor_days: u32,
    pub lock_key: BytesN<32>,
    pub nullifier: BytesN<32>,
}

#[contractevent(topics = ["DrawExecuted"])]
pub struct DrawExecuted {
    pub position_id: BytesN<32>,
    pub anchor: Address,
    pub facility: Address,
    pub transfer_commitment_x: BytesN<32>,
    pub transfer_commitment_y: BytesN<32>,
}

#[contractevent(topics = ["CollateralSeized"])]
pub struct CollateralSeized {
    pub position_id: BytesN<32>,
    pub anchor: Address,
    pub collateral_token: Address,
    pub lock_key: BytesN<32>,
    pub seized_at_ledger: u32,
}

#[contractevent(topics = ["Repaid"])]
pub struct Repaid {
    pub position_id: BytesN<32>,
    pub anchor: Address,
    pub repayment_commitment: BytesN<32>,
    pub closed_at_ledger: u32,
}

#[contracttype]
enum StorageKey {
    ParticipantPolicy,
    CollateralPolicyRegistry,
    CollateralLockRegistry,
    CollateralSufficiencyVerifier,
    CreditToken,
    UsedNullifier(BytesN<32>),
    Position(BytesN<32>),
    Paused,
}

#[contract]
pub struct PrefundingCreditLineContract;

#[contractimpl]
impl PrefundingCreditLineContract {
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        e: &Env,
        admin: Address,
        manager: Address,
        participant_policy: Address,
        collateral_policy_registry: Address,
        collateral_lock_registry: Address,
        cs_verifier: Address,
        credit_token: Address,
    ) {
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
        e.storage().instance().set(&StorageKey::ParticipantPolicy, &participant_policy);
        e.storage()
            .instance()
            .set(&StorageKey::CollateralPolicyRegistry, &collateral_policy_registry);
        e.storage()
            .instance()
            .set(&StorageKey::CollateralLockRegistry, &collateral_lock_registry);
        e.storage()
            .instance()
            .set(&StorageKey::CollateralSufficiencyVerifier, &cs_verifier);
        // The draw/repayment currency is pinned once at construction, not
        // caller-supplied at execute_draw/repay time: unlike collateral_token
        // (validated against the collateral-policy registry's eligibility
        // whitelist), there is no equivalent registry for the credit
        // currency, so accepting it as a parameter would let a compromised
        // operator point the transfer cross-call at a fake contract that
        // trivially "succeeds" without moving real value.
        e.storage().instance().set(&StorageKey::CreditToken, &credit_token);
    }

    // ---- P1 safety: emergency pause + admin-gated upgrade ----

    /// Emergency stop. Blocks new `open_credit`/`execute_draw` while paused;
    /// `repay` and `liquidate` stay available so positions can always wind down.
    /// Gated on the admin (put that admin behind a timelocked multisig), a
    /// separate authority from the day-to-day `manager` operator.
    #[only_admin]
    pub fn pause(e: &Env) {
        e.storage().instance().set(&StorageKey::Paused, &true);
    }

    #[only_admin]
    pub fn unpause(e: &Env) {
        e.storage().instance().set(&StorageKey::Paused, &false);
    }

    pub fn paused(e: &Env) -> bool {
        e.storage().instance().get(&StorageKey::Paused).unwrap_or(false)
    }

    /// Admin-gated WASM upgrade so bugs are fixable on immutable mainnet
    /// contracts. Keep the admin behind a timelocked multisig.
    #[only_admin]
    pub fn upgrade(e: &Env, new_wasm_hash: BytesN<32>) {
        upgradeable::upgrade(e, &new_wasm_hash);
    }

    fn ensure_not_paused(e: &Env) {
        if Self::paused(e) {
            panic_with_error!(e, CreditLineError::Paused);
        }
    }

    #[allow(clippy::too_many_arguments)]
    #[only_role(operator, "manager")]
    pub fn open_credit(
        e: &Env,
        position_id: BytesN<32>,
        anchor: Address,
        collateral_token: Address,
        lock_key: BytesN<32>,
        credit_commitment_x: BytesN<32>,
        credit_commitment_y: BytesN<32>,
        oracle_price_e7: u128,
        haircut_bps: u32,
        tenor_days: u32,
        position_nullifier: BytesN<32>,
        public_inputs: Bytes,
        proof: Bytes,
        operator: Address,
    ) -> BytesN<32> {
        Self::ensure_not_paused(e);
        // The anchor whose collateral backs this position must consent to it
        // being opened; without this, the operator alone could bind any anchor.
        anchor.require_auth();

        if e.storage().persistent().has(&StorageKey::Position(position_id.clone())) {
            panic_with_error!(e, CreditLineError::PositionAlreadyExists);
        }
        if e.storage()
            .persistent()
            .has(&StorageKey::UsedNullifier(position_nullifier.clone()))
        {
            panic_with_error!(e, CreditLineError::NullifierAlreadyUsed);
        }
        if !Self::participant_approved(e, anchor.clone()) {
            panic_with_error!(e, CreditLineError::ParticipantNotApproved);
        }

        // O1: fetch the whole collateral policy once instead of five cross-calls.
        let policy = Self::collateral_policy(e, collateral_token.clone());
        if tenor_days == 0 || tenor_days > 5 || tenor_days > policy.max_tenor_days {
            panic_with_error!(e, CreditLineError::TenorTooLong);
        }
        if !policy.eligible {
            panic_with_error!(e, CreditLineError::CollateralIneligible);
        }

        // O2: fetch price + freshness in a single oracle read.
        let price = Self::oracle_price_data(e, policy.oracle.clone(), collateral_token.clone());
        if e.ledger().sequence().saturating_sub(price.updated_ledger) > policy.max_staleness_ledgers
        {
            panic_with_error!(e, CreditLineError::StaleOraclePrice);
        }
        if price.price_e7 <= 0 || price.price_e7 as u128 != oracle_price_e7 {
            panic_with_error!(e, CreditLineError::InvalidAmount);
        }
        if policy.haircut_bps != haircut_bps {
            panic_with_error!(e, CreditLineError::PublicInputsMismatch);
        }
        // C1: source the collateral commitment and ownership key from the
        // anchor's REAL confidential-token account. The prover can no longer
        // supply an invented commitment; the proof must open this exact
        // spendable balance AND prove ownership of its `spending_key`.
        let account = Self::confidential_account(e, collateral_token.clone(), anchor.clone());
        let (c_spend_x, c_spend_y) = Self::split_point(e, &account.spendable_balance);
        let (y_x, y_y) = Self::split_point(e, &account.spending_key);

        let expected_public_inputs = Self::public_inputs(
            e,
            c_spend_x.clone(),
            c_spend_y.clone(),
            y_x,
            y_y,
            credit_commitment_x.clone(),
            credit_commitment_y.clone(),
            oracle_price_e7,
            haircut_bps,
            tenor_days,
            lock_key.clone(),
            position_nullifier.clone(),
        );
        if expected_public_inputs != public_inputs {
            panic_with_error!(e, CreditLineError::PublicInputsMismatch);
        }

        // K6 (checks-effects-interactions): commit the replay guard BEFORE any
        // external verifier/registry call. If verification or locking fails, the
        // whole transaction panics and this write is reverted; if a called
        // contract tries to re-enter with the same nullifier, it is now rejected.
        let nullifier_key = StorageKey::UsedNullifier(position_nullifier.clone());
        e.storage().persistent().set(&nullifier_key, &true);
        e.storage()
            .persistent()
            .extend_ttl(&nullifier_key, STATE_TTL_THRESHOLD, STATE_TTL_EXTEND_TO);

        if !Self::verify_collateral_sufficiency(e, public_inputs, proof) {
            panic_with_error!(e, CreditLineError::ProofVerificationFailed);
        }
        if Self::lock_is_active(e, lock_key.clone()) {
            panic_with_error!(e, CreditLineError::LockAlreadyUsed);
        }

        let due_ledger = e
            .ledger()
            .sequence()
            .saturating_add(tenor_days.saturating_mul(LEDGERS_PER_DAY));
        // Passes `tenor_days` (a proven, ledger-independent public input) to
        // the lock registry rather than this `due_ledger`, so the registry
        // can compute its own expiry from `e.ledger().sequence()` read at its
        // own execution time -- both computations happen within the same
        // atomic transaction, so they land on the same ledger and agree,
        // without baking a simulation-time ledger number into an authorized
        // cross-contract call's arguments.
        Self::lock_collateral(
            e,
            lock_key.clone(),
            anchor.clone(),
            collateral_token.clone(),
            position_id.clone(),
            tenor_days,
            operator.clone(),
        );
        // F2: actually encumber the collateral. Freezing the anchor's confidential
        // collateral account prevents them moving the pledged asset while the
        // credit is outstanding; `repay` unfreezes, `liquidate` keeps it frozen.
        Self::freeze_collateral(e, collateral_token.clone(), anchor.clone(), operator.clone());

        let position_key = StorageKey::Position(position_id.clone());
        e.storage().persistent().set(
            &position_key,
            &CreditPosition {
                open: true,
                drawn: false,
                anchor: anchor.clone(),
                collateral_token: collateral_token.clone(),
                lock_key: lock_key.clone(),
                collateral_commitment_x: c_spend_x,
                collateral_commitment_y: c_spend_y,
                credit_commitment_x,
                credit_commitment_y,
                position_nullifier: position_nullifier.clone(),
                tenor_days,
                opened_ledger: e.ledger().sequence(),
                due_ledger,
                proof_verified: true,
                defaulted: false,
            },
        );
        e.storage()
            .persistent()
            .extend_ttl(&position_key, STATE_TTL_THRESHOLD, STATE_TTL_EXTEND_TO);
        CreditOpened {
            position_id: position_id.clone(),
            anchor,
            collateral_asset: collateral_token,
            tenor_days,
            lock_key,
            nullifier: position_nullifier,
        }
        .publish(e);
        position_id
    }

    #[allow(clippy::too_many_arguments)]
    #[only_role(operator, "manager")]
    pub fn execute_draw(
        e: &Env,
        position_id: BytesN<32>,
        facility: Address,
        credit_executor: Address,
        transfer_commitment_x: BytesN<32>,
        transfer_commitment_y: BytesN<32>,
        transfer_data: Bytes,
        operator: Address,
    ) {
        Self::ensure_not_paused(e);
        // `confidential_transfer_from`'s delegated `spender` must be a real
        // registered confidential account (its spending key is used for the
        // allowance's ECDH escrow) -- a contract address cannot hold that key
        // material, so unlike the anchor/facility args, this contract cannot
        // act as its own spender. `credit_executor` is the real EOA the
        // facility delegated an allowance to via `set_spender`; it must
        // co-sign this call, the same multi-party pattern K3 uses for the
        // anchor in `open_credit`.
        credit_executor.require_auth();
        let mut position = Self::position(e, position_id.clone());
        if !position.open {
            panic_with_error!(e, CreditLineError::PositionNotOpen);
        }
        if position.defaulted {
            panic_with_error!(e, CreditLineError::PositionDefaulted);
        }
        if position.drawn {
            panic_with_error!(e, CreditLineError::PositionAlreadyDrawn);
        }
        // Accounting invariant: never release liquidity unless the collateral is
        // still locked. Defence in depth against a released/seized escrow.
        if !Self::lock_is_active(e, position.lock_key.clone()) {
            panic_with_error!(e, CreditLineError::CollateralNotLocked);
        }
        // K2: the released draw must commit to exactly the credit amount proven
        // sufficient at open. Pedersen binding means equal commitments => equal
        // amounts, so the facility cannot release more than was collateralised.
        if transfer_commitment_x != position.credit_commitment_x
            || transfer_commitment_y != position.credit_commitment_y
        {
            panic_with_error!(e, CreditLineError::DrawCommitmentMismatch);
        }
        position.drawn = true;
        let anchor = position.anchor.clone();
        // K6 (checks-effects-interactions): commit `drawn = true` before the
        // cross-contract transfer call, so a reentrant execute_draw during the
        // token's transfer hooks sees the position as already drawn. If the
        // transfer call below panics (bad proof, no allowance, wrong amount),
        // Soroban unwinds this whole transaction including this write.
        e.storage()
            .persistent()
            .set(&StorageKey::Position(position_id.clone()), &position);
        // Was previously a gap: execute_draw only checked the commitment
        // matched the proven credit amount, but never verified a real transfer
        // happened -- the actual confidential_transfer_from was a separate,
        // non-atomic transaction the backend submitted independently, so an
        // operator could mark a position drawn without ever moving real
        // value. Now the credit-line contract performs the transfer itself,
        // atomically, as part of this same call.
        Self::draw_transfer(e, credit_executor, facility.clone(), anchor.clone(), transfer_data);
        DrawExecuted {
            position_id,
            anchor,
            facility,
            transfer_commitment_x,
            transfer_commitment_y,
        }
        .publish(e);
    }

    #[only_role(operator, "manager")]
    pub fn repay(
        e: &Env,
        position_id: BytesN<32>,
        facility: Address,
        repayment_commitment: BytesN<32>,
        transfer_data: Bytes,
        operator: Address,
    ) {
        let mut position = Self::position(e, position_id.clone());
        if !position.open {
            panic_with_error!(e, CreditLineError::PositionNotOpen);
        }
        if position.defaulted {
            panic_with_error!(e, CreditLineError::PositionDefaulted);
        }
        let anchor = position.anchor.clone();
        // Repayment debits the anchor's own confidential balance, so unlike
        // the operator-only draw/liquidate path, the anchor must consent here
        // too (same reasoning as K3's open_credit anchor.require_auth()).
        anchor.require_auth();
        let collateral_token = position.collateral_token.clone();
        position.open = false;
        e.storage()
            .persistent()
            .set(&StorageKey::Position(position_id.clone()), &position);
        Self::release_collateral(e, position.lock_key.clone(), operator.clone());
        // F2: releasing the credit line unfreezes the pledged collateral account.
        Self::unfreeze_collateral(e, collateral_token, anchor.clone(), operator);
        // Was previously a gap: repay() closed the position and unfroze the
        // collateral purely on the operator's say-so that a repayment had
        // been made elsewhere, with no on-chain check. Now repay() performs
        // the confidential_transfer itself: `from.require_auth()` inside the
        // token contract is satisfied by the anchor's own signature already
        // collected on this transaction above, so the transfer and the
        // position closure/unfreeze are one atomic unit -- if the repayment
        // proof is invalid, the whole call (including the unfreeze) reverts.
        Self::repay_transfer(e, anchor.clone(), facility, transfer_data);
        Repaid {
            position_id,
            anchor,
            repayment_commitment,
            closed_at_ledger: e.ledger().sequence(),
        }
        .publish(e);
    }

    /// F2 default path: after the due ledger passes without repayment, seize the
    /// collateral. The position is marked defaulted, the collateral lock stays
    /// active and the account stays frozen (so the anchor cannot reclaim or move
    /// it), and a `CollateralSeized` event authorises the facility's recovery
    /// workflow. Repayment is blocked once defaulted.
    ///
    /// Role separation: liquidation is gated on a dedicated `liquidator` role
    /// (granted by the admin), distinct from the `manager` operator that runs
    /// open/draw/repay and the admin that pauses/upgrades.
    #[only_role(liquidator, "liquidator")]
    pub fn liquidate(e: &Env, position_id: BytesN<32>, liquidator: Address) {
        let _ = &liquidator;
        let mut position = Self::position(e, position_id.clone());
        if !position.open {
            panic_with_error!(e, CreditLineError::PositionNotOpen);
        }
        if position.defaulted {
            panic_with_error!(e, CreditLineError::PositionDefaulted);
        }
        if e.ledger().sequence() <= position.due_ledger {
            panic_with_error!(e, CreditLineError::NotYetDue);
        }
        position.defaulted = true;
        let anchor = position.anchor.clone();
        let collateral_token = position.collateral_token.clone();
        let lock_key = position.lock_key.clone();
        e.storage()
            .persistent()
            .set(&StorageKey::Position(position_id.clone()), &position);
        CollateralSeized {
            position_id,
            anchor,
            collateral_token,
            lock_key,
            seized_at_ledger: e.ledger().sequence(),
        }
        .publish(e);
    }

    pub fn position(e: &Env, position_id: BytesN<32>) -> CreditPosition {
        e.storage()
            .persistent()
            .get(&StorageKey::Position(position_id))
            .unwrap_or_else(|| {
                panic_with_error!(e, CreditLineError::PositionNotFound);
            })
    }

    pub fn is_nullifier_used(e: &Env, position_nullifier: BytesN<32>) -> bool {
        e.storage()
            .persistent()
            .get(&StorageKey::UsedNullifier(position_nullifier))
            .unwrap_or(false)
    }

    fn participant_policy(e: &Env) -> Address {
        e.storage().instance().get(&StorageKey::ParticipantPolicy).unwrap()
    }

    fn credit_token(e: &Env) -> Address {
        e.storage().instance().get(&StorageKey::CreditToken).unwrap()
    }

    fn collateral_registry(e: &Env) -> Address {
        e.storage()
            .instance()
            .get(&StorageKey::CollateralPolicyRegistry)
            .unwrap()
    }

    fn lock_registry(e: &Env) -> Address {
        e.storage().instance().get(&StorageKey::CollateralLockRegistry).unwrap()
    }

    fn collateral_sufficiency_verifier(e: &Env) -> Address {
        e.storage()
            .instance()
            .get(&StorageKey::CollateralSufficiencyVerifier)
            .unwrap()
    }

    fn invoke_bool(e: &Env, contract: Address, function: &str, args: Vec<Val>) -> bool {
        e.invoke_contract(&contract, &Symbol::new(e, function), args)
    }

    fn participant_approved(e: &Env, anchor: Address) -> bool {
        let mut args = Vec::new(e);
        args.push_back(anchor.into_val(e));
        Self::invoke_bool(e, Self::participant_policy(e), "is_approved", args)
    }

    fn collateral_policy(e: &Env, token: Address) -> CollateralPolicyData {
        let mut args = Vec::new(e);
        args.push_back(token.into_val(e));
        e.invoke_contract(&Self::collateral_registry(e), &Symbol::new(e, "policy"), args)
    }

    fn oracle_price_data(e: &Env, oracle: Address, token: Address) -> OraclePriceData {
        let mut args = Vec::new(e);
        args.push_back(token.into_val(e));
        e.invoke_contract(&oracle, &Symbol::new(e, "price"), args)
    }

    fn confidential_account(e: &Env, token: Address, account: Address) -> ConfidentialAccountData {
        let mut args = Vec::new(e);
        args.push_back(account.into_val(e));
        e.invoke_contract(&token, &Symbol::new(e, "confidential_balance"), args)
    }

    // Splits a Grumpkin point (x || y, 32 bytes each) into its two coordinates.
    fn split_point(e: &Env, p: &BytesN<64>) -> (BytesN<32>, BytesN<32>) {
        let a = p.to_array();
        let mut x = [0u8; 32];
        let mut y = [0u8; 32];
        x.copy_from_slice(&a[0..32]);
        y.copy_from_slice(&a[32..64]);
        (BytesN::from_array(e, &x), BytesN::from_array(e, &y))
    }

    fn lock_is_active(e: &Env, lock_key: BytesN<32>) -> bool {
        let mut args = Vec::new(e);
        args.push_back(lock_key.into_val(e));
        Self::invoke_bool(e, Self::lock_registry(e), "is_locked", args)
    }

    fn verify_collateral_sufficiency(e: &Env, public_inputs: Bytes, proof: Bytes) -> bool {
        let mut args = Vec::new(e);
        args.push_back(public_inputs.into_val(e));
        args.push_back(proof.into_val(e));
        Self::invoke_bool(e, Self::collateral_sufficiency_verifier(e), "verify_proof", args)
    }

    // Canonical public-input encoding, matching collateral_sufficiency v2:
    // c_spend(x,y) | Y(x,y) | credit_commitment(x,y) | price | haircut | tenor |
    // lock_key | position_nullifier. c_spend and Y are sourced on-chain from the
    // anchor's confidential account, not from the caller.
    #[allow(clippy::too_many_arguments)]
    fn public_inputs(
        e: &Env,
        c_spend_x: BytesN<32>,
        c_spend_y: BytesN<32>,
        y_x: BytesN<32>,
        y_y: BytesN<32>,
        credit_commitment_x: BytesN<32>,
        credit_commitment_y: BytesN<32>,
        oracle_price_e7: u128,
        haircut_bps: u32,
        tenor_days: u32,
        lock_key: BytesN<32>,
        position_nullifier: BytesN<32>,
    ) -> Bytes {
        let mut out = Bytes::new(e);
        out.append(&Bytes::from_array(e, &c_spend_x.to_array()));
        out.append(&Bytes::from_array(e, &c_spend_y.to_array()));
        out.append(&Bytes::from_array(e, &y_x.to_array()));
        out.append(&Bytes::from_array(e, &y_y.to_array()));
        out.append(&Bytes::from_array(e, &credit_commitment_x.to_array()));
        out.append(&Bytes::from_array(e, &credit_commitment_y.to_array()));
        out.append(&Self::u128_field_bytes(e, oracle_price_e7));
        out.append(&Self::u128_field_bytes(e, haircut_bps as u128));
        out.append(&Self::u128_field_bytes(e, tenor_days as u128));
        out.append(&Bytes::from_array(e, &lock_key.to_array()));
        out.append(&Bytes::from_array(e, &position_nullifier.to_array()));
        out
    }

    fn u128_field_bytes(e: &Env, value: u128) -> Bytes {
        let mut bytes = [0u8; 32];
        bytes[16..].copy_from_slice(&value.to_be_bytes());
        Bytes::from_array(e, &bytes)
    }

    // Passes `tenor_days`, not a precomputed `expiry_ledger` -- see the
    // comment on `CollateralLockRegistry::lock`. Using a value derived from
    // `e.ledger().sequence()` here would make this call's authorized
    // invocation arguments drift between simulation and execution.
    fn lock_collateral(
        e: &Env,
        lock_key: BytesN<32>,
        owner: Address,
        collateral_token: Address,
        position_id: BytesN<32>,
        tenor_days: u32,
        operator: Address,
    ) {
        let mut args = Vec::new(e);
        args.push_back(lock_key.into_val(e));
        args.push_back(owner.into_val(e));
        args.push_back(collateral_token.into_val(e));
        args.push_back(position_id.into_val(e));
        args.push_back(tenor_days.into_val(e));
        args.push_back(operator.into_val(e));
        e.invoke_contract::<()>(&Self::lock_registry(e), &Symbol::new(e, "lock"), args);
    }

    fn release_collateral(e: &Env, lock_key: BytesN<32>, operator: Address) {
        let mut args = Vec::new(e);
        args.push_back(lock_key.into_val(e));
        args.push_back(operator.into_val(e));
        e.invoke_contract::<()>(&Self::lock_registry(e), &Symbol::new(e, "release"), args);
    }

    // Freezes/unfreezes the anchor's confidential collateral account on the
    // confidential token via its compliance hook. Requires this contract's
    // `operator` to hold the manager role on `collateral_token`.
    fn freeze_collateral(e: &Env, collateral_token: Address, account: Address, operator: Address) {
        let mut args = Vec::new(e);
        args.push_back(account.into_val(e));
        args.push_back(operator.into_val(e));
        e.invoke_contract::<()>(&collateral_token, &Symbol::new(e, "freeze"), args);
    }

    fn unfreeze_collateral(e: &Env, collateral_token: Address, account: Address, operator: Address) {
        let mut args = Vec::new(e);
        args.push_back(account.into_val(e));
        args.push_back(operator.into_val(e));
        e.invoke_contract::<()>(&collateral_token, &Symbol::new(e, "unfreeze"), args);
    }

    // Draw: releases facility funds to the anchor via the real EOA the
    // facility delegated an allowance to (`credit_executor`, already
    // `require_auth()`'d by the caller above). A contract address cannot
    // serve as the spender here -- `set_spender`'s delegation escrows the
    // spender's real spending key for the allowance's ECDH, which only a
    // genuine registered confidential account (a real keypair) has.
    fn draw_transfer(e: &Env, credit_executor: Address, facility: Address, anchor: Address, transfer_data: Bytes) {
        let mut args = Vec::new(e);
        args.push_back(credit_executor.into_val(e));
        args.push_back(facility.into_val(e));
        args.push_back(anchor.into_val(e));
        args.push_back(transfer_data.into_val(e));
        e.invoke_contract::<()>(
            &Self::credit_token(e),
            &Symbol::new(e, "confidential_transfer_from"),
            args,
        );
    }

    // Repay: debits the anchor's own balance to the facility.
    // `from.require_auth()` inside `confidential_transfer` is satisfied by
    // the anchor's own signature already required on the outer `repay` call.
    fn repay_transfer(e: &Env, anchor: Address, facility: Address, transfer_data: Bytes) {
        let mut args = Vec::new(e);
        args.push_back(anchor.into_val(e));
        args.push_back(facility.into_val(e));
        args.push_back(transfer_data.into_val(e));
        e.invoke_contract::<()>(&Self::credit_token(e), &Symbol::new(e, "confidential_transfer"), args);
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for PrefundingCreditLineContract {}
