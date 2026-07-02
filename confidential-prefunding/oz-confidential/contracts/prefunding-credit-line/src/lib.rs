#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_macros::only_role;

const MANAGER_ROLE: Symbol = symbol_short!("manager");
const LEDGERS_PER_DAY: u32 = 17_280;

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
    pub transfer_commitment: BytesN<32>,
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
    UsedNullifier(BytesN<32>),
    Position(BytesN<32>),
}

#[contract]
pub struct PrefundingCreditLineContract;

#[contractimpl]
impl PrefundingCreditLineContract {
    pub fn __constructor(
        e: &Env,
        admin: Address,
        manager: Address,
        participant_policy: Address,
        collateral_policy_registry: Address,
        collateral_lock_registry: Address,
        cs_verifier: Address,
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
    }

    #[allow(clippy::too_many_arguments)]
    #[only_role(operator, "manager")]
    pub fn open_credit(
        e: &Env,
        position_id: BytesN<32>,
        anchor: Address,
        collateral_token: Address,
        lock_key: BytesN<32>,
        collateral_commitment_x: BytesN<32>,
        collateral_commitment_y: BytesN<32>,
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

        let max_tenor = Self::collateral_max_tenor(e, collateral_token.clone());
        if tenor_days == 0 || tenor_days > 5 || tenor_days > max_tenor {
            panic_with_error!(e, CreditLineError::TenorTooLong);
        }
        if !Self::collateral_eligible(e, collateral_token.clone()) {
            panic_with_error!(e, CreditLineError::CollateralIneligible);
        }

        let oracle = Self::collateral_oracle(e, collateral_token.clone());
        let max_staleness = Self::collateral_max_staleness(e, collateral_token.clone());
        if !Self::oracle_fresh(e, oracle.clone(), collateral_token.clone(), max_staleness) {
            panic_with_error!(e, CreditLineError::StaleOraclePrice);
        }
        let price_e7 = Self::oracle_price(e, oracle, collateral_token.clone());
        if price_e7 <= 0 || price_e7 as u128 != oracle_price_e7 {
            panic_with_error!(e, CreditLineError::InvalidAmount);
        }
        if Self::collateral_haircut(e, collateral_token.clone()) != haircut_bps {
            panic_with_error!(e, CreditLineError::PublicInputsMismatch);
        }
        let expected_public_inputs = Self::public_inputs(
            e,
            collateral_commitment_x.clone(),
            collateral_commitment_y.clone(),
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
        Self::lock_collateral(
            e,
            lock_key.clone(),
            anchor.clone(),
            collateral_token.clone(),
            position_id.clone(),
            due_ledger,
            operator.clone(),
        );

        e.storage().persistent().set(
            &StorageKey::Position(position_id.clone()),
            &CreditPosition {
                open: true,
                drawn: false,
                anchor: anchor.clone(),
                collateral_token: collateral_token.clone(),
                lock_key: lock_key.clone(),
                collateral_commitment_x,
                collateral_commitment_y,
                credit_commitment_x,
                credit_commitment_y,
                position_nullifier: position_nullifier.clone(),
                tenor_days,
                opened_ledger: e.ledger().sequence(),
                due_ledger,
                proof_verified: true,
            },
        );
        e.storage()
            .persistent()
            .set(&StorageKey::UsedNullifier(position_nullifier.clone()), &true);
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

    #[only_role(operator, "manager")]
    pub fn execute_draw(
        e: &Env,
        position_id: BytesN<32>,
        facility: Address,
        transfer_commitment: BytesN<32>,
        operator: Address,
    ) {
        let mut position = Self::position(e, position_id.clone());
        if !position.open {
            panic_with_error!(e, CreditLineError::PositionNotOpen);
        }
        if position.drawn {
            panic_with_error!(e, CreditLineError::PositionAlreadyDrawn);
        }
        position.drawn = true;
        let anchor = position.anchor.clone();
        e.storage()
            .persistent()
            .set(&StorageKey::Position(position_id.clone()), &position);
        DrawExecuted {
            position_id,
            anchor,
            facility,
            transfer_commitment,
        }
        .publish(e);
    }

    #[only_role(operator, "manager")]
    pub fn repay(
        e: &Env,
        position_id: BytesN<32>,
        repayment_commitment: BytesN<32>,
        operator: Address,
    ) {
        let mut position = Self::position(e, position_id.clone());
        if !position.open {
            panic_with_error!(e, CreditLineError::PositionNotOpen);
        }
        let anchor = position.anchor.clone();
        position.open = false;
        Self::release_collateral(e, position.lock_key.clone(), operator);
        e.storage()
            .persistent()
            .set(&StorageKey::Position(position_id.clone()), &position);
        Repaid {
            position_id,
            anchor,
            repayment_commitment,
            closed_at_ledger: e.ledger().sequence(),
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

    fn invoke_u32(e: &Env, contract: Address, function: &str, args: Vec<Val>) -> u32 {
        e.invoke_contract(&contract, &Symbol::new(e, function), args)
    }

    fn invoke_i128(e: &Env, contract: Address, function: &str, args: Vec<Val>) -> i128 {
        e.invoke_contract(&contract, &Symbol::new(e, function), args)
    }

    fn invoke_address(e: &Env, contract: Address, function: &str, args: Vec<Val>) -> Address {
        e.invoke_contract(&contract, &Symbol::new(e, function), args)
    }

    fn participant_approved(e: &Env, anchor: Address) -> bool {
        let mut args = Vec::new(e);
        args.push_back(anchor.into_val(e));
        Self::invoke_bool(e, Self::participant_policy(e), "is_approved", args)
    }

    fn collateral_eligible(e: &Env, token: Address) -> bool {
        let mut args = Vec::new(e);
        args.push_back(token.into_val(e));
        Self::invoke_bool(e, Self::collateral_registry(e), "is_eligible", args)
    }

    fn collateral_haircut(e: &Env, token: Address) -> u32 {
        let mut args = Vec::new(e);
        args.push_back(token.into_val(e));
        Self::invoke_u32(e, Self::collateral_registry(e), "haircut_bps", args)
    }

    fn collateral_max_tenor(e: &Env, token: Address) -> u32 {
        let mut args = Vec::new(e);
        args.push_back(token.into_val(e));
        Self::invoke_u32(e, Self::collateral_registry(e), "max_tenor_days", args)
    }

    fn collateral_oracle(e: &Env, token: Address) -> Address {
        let mut args = Vec::new(e);
        args.push_back(token.into_val(e));
        Self::invoke_address(e, Self::collateral_registry(e), "oracle", args)
    }

    fn collateral_max_staleness(e: &Env, token: Address) -> u32 {
        let mut args = Vec::new(e);
        args.push_back(token.into_val(e));
        Self::invoke_u32(e, Self::collateral_registry(e), "max_staleness_ledgers", args)
    }

    fn oracle_price(e: &Env, oracle: Address, token: Address) -> i128 {
        let mut args = Vec::new(e);
        args.push_back(token.into_val(e));
        Self::invoke_i128(e, oracle, "price_e7", args)
    }

    fn oracle_fresh(e: &Env, oracle: Address, token: Address, max_staleness: u32) -> bool {
        let updated = {
            let mut args = Vec::new(e);
            args.push_back(token.into_val(e));
            Self::invoke_u32(e, oracle, "updated_ledger", args)
        };
        e.ledger().sequence().saturating_sub(updated) <= max_staleness
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

    #[allow(clippy::too_many_arguments)]
    fn public_inputs(
        e: &Env,
        collateral_commitment_x: BytesN<32>,
        collateral_commitment_y: BytesN<32>,
        credit_commitment_x: BytesN<32>,
        credit_commitment_y: BytesN<32>,
        oracle_price_e7: u128,
        haircut_bps: u32,
        tenor_days: u32,
        lock_key: BytesN<32>,
        position_nullifier: BytesN<32>,
    ) -> Bytes {
        let mut out = Bytes::new(e);
        out.append(&Bytes::from_array(e, &collateral_commitment_x.to_array()));
        out.append(&Bytes::from_array(e, &collateral_commitment_y.to_array()));
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

    fn lock_collateral(
        e: &Env,
        lock_key: BytesN<32>,
        owner: Address,
        collateral_token: Address,
        position_id: BytesN<32>,
        expiry_ledger: u32,
        operator: Address,
    ) {
        let mut args = Vec::new(e);
        args.push_back(lock_key.into_val(e));
        args.push_back(owner.into_val(e));
        args.push_back(collateral_token.into_val(e));
        args.push_back(position_id.into_val(e));
        args.push_back(expiry_ledger.into_val(e));
        args.push_back(operator.into_val(e));
        e.invoke_contract::<()>(&Self::lock_registry(e), &Symbol::new(e, "lock"), args);
    }

    fn release_collateral(e: &Env, lock_key: BytesN<32>, operator: Address) {
        let mut args = Vec::new(e);
        args.push_back(lock_key.into_val(e));
        args.push_back(operator.into_val(e));
        e.invoke_contract::<()>(&Self::lock_registry(e), &Symbol::new(e, "release"), args);
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for PrefundingCreditLineContract {}
