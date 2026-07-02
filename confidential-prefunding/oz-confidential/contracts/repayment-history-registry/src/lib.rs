#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Bytes, BytesN, Env, IntoVal, Symbol, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_macros::only_role;

const MANAGER_ROLE: Symbol = symbol_short!("manager");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RepaymentHistoryError {
    DuplicateLeaf = 4701,
    DuplicateProofNullifier = 4702,
    HistoryRootNotSet = 4703,
    ProofVerificationFailed = 4704,
    PublicInputsMismatch = 4705,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepaymentLeaf {
    pub position_id: BytesN<32>,
    pub leaf_nullifier: BytesN<32>,
    pub repayment_commitment: BytesN<32>,
    pub paid_ledger: u32,
    pub due_ledger: u32,
    pub on_time: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HistoryRoot {
    pub root: BytesN<32>,
    pub leaf_count: u32,
    pub updated_at_ledger: u32,
}

#[contractevent(topics = ["RepaymentLeafSeeded"])]
pub struct RepaymentLeafSeeded {
    pub position_id: BytesN<32>,
    pub leaf_nullifier: BytesN<32>,
    pub repayment_commitment: BytesN<32>,
    pub paid_ledger: u32,
    pub due_ledger: u32,
    pub on_time: bool,
}

#[contractevent(topics = ["RepaymentHistoryRootSet"])]
pub struct RepaymentHistoryRootSet {
    pub position_id: BytesN<32>,
    pub history_root: BytesN<32>,
    pub leaf_count: u32,
}

#[contractevent(topics = ["RepaymentHistoryVerified"])]
pub struct RepaymentHistoryVerified {
    pub position_id: BytesN<32>,
    pub history_root: BytesN<32>,
    pub threshold: u32,
    pub proof_nullifier: BytesN<32>,
}

#[contracttype]
enum StorageKey {
    Verifier,
    Root(BytesN<32>),
    Leaf(BytesN<32>),
    ProofNullifier(BytesN<32>),
}

#[contract]
pub struct RepaymentHistoryRegistryContract;

#[contractimpl]
impl RepaymentHistoryRegistryContract {
    pub fn __constructor(e: &Env, admin: Address, manager: Address, verifier: Address) {
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
        e.storage().instance().set(&StorageKey::Verifier, &verifier);
    }

    #[only_role(operator, "manager")]
    pub fn seed_leaf(
        e: &Env,
        position_id: BytesN<32>,
        leaf_nullifier: BytesN<32>,
        repayment_commitment: BytesN<32>,
        paid_ledger: u32,
        due_ledger: u32,
        operator: Address,
    ) {
        if e.storage().persistent().has(&StorageKey::Leaf(leaf_nullifier.clone())) {
            panic_with_error!(e, RepaymentHistoryError::DuplicateLeaf);
        }
        let leaf = RepaymentLeaf {
            position_id: position_id.clone(),
            leaf_nullifier: leaf_nullifier.clone(),
            repayment_commitment: repayment_commitment.clone(),
            paid_ledger,
            due_ledger,
            on_time: paid_ledger <= due_ledger,
        };
        e.storage()
            .persistent()
            .set(&StorageKey::Leaf(leaf_nullifier.clone()), &leaf);
        RepaymentLeafSeeded {
            position_id,
            leaf_nullifier,
            repayment_commitment,
            paid_ledger,
            due_ledger,
            on_time: leaf.on_time,
        }
        .publish(e);
    }

    #[only_role(operator, "manager")]
    pub fn set_history_root(
        e: &Env,
        position_id: BytesN<32>,
        history_root: BytesN<32>,
        leaf_count: u32,
        operator: Address,
    ) {
        e.storage().persistent().set(
            &StorageKey::Root(position_id.clone()),
            &HistoryRoot {
                root: history_root.clone(),
                leaf_count,
                updated_at_ledger: e.ledger().sequence(),
            },
        );
        RepaymentHistoryRootSet {
            position_id,
            history_root,
            leaf_count,
        }
        .publish(e);
    }

    #[only_role(operator, "manager")]
    pub fn verify_history(
        e: &Env,
        position_id: BytesN<32>,
        threshold: u32,
        proof_nullifier: BytesN<32>,
        public_inputs: Bytes,
        proof: Bytes,
        operator: Address,
    ) -> bool {
        if e.storage()
            .persistent()
            .has(&StorageKey::ProofNullifier(proof_nullifier.clone()))
        {
            panic_with_error!(e, RepaymentHistoryError::DuplicateProofNullifier);
        }
        let root = Self::history_root(e, position_id.clone());
        let expected_public_inputs = Self::public_inputs(
            e,
            position_id.clone(),
            root.root.clone(),
            threshold,
            proof_nullifier.clone(),
        );
        if expected_public_inputs != public_inputs {
            panic_with_error!(e, RepaymentHistoryError::PublicInputsMismatch);
        }
        if !Self::verify_proof(e, public_inputs, proof) {
            panic_with_error!(e, RepaymentHistoryError::ProofVerificationFailed);
        }
        e.storage()
            .persistent()
            .set(&StorageKey::ProofNullifier(proof_nullifier.clone()), &true);
        RepaymentHistoryVerified {
            position_id,
            history_root: root.root,
            threshold,
            proof_nullifier,
        }
        .publish(e);
        true
    }

    pub fn history_root(e: &Env, position_id: BytesN<32>) -> HistoryRoot {
        e.storage()
            .persistent()
            .get(&StorageKey::Root(position_id))
            .unwrap_or_else(|| panic_with_error!(e, RepaymentHistoryError::HistoryRootNotSet))
    }

    pub fn leaf(e: &Env, leaf_nullifier: BytesN<32>) -> RepaymentLeaf {
        e.storage()
            .persistent()
            .get(&StorageKey::Leaf(leaf_nullifier))
            .unwrap_or_else(|| panic_with_error!(e, RepaymentHistoryError::DuplicateLeaf))
    }

    pub fn is_proof_nullifier_used(e: &Env, proof_nullifier: BytesN<32>) -> bool {
        e.storage()
            .persistent()
            .get(&StorageKey::ProofNullifier(proof_nullifier))
            .unwrap_or(false)
    }

    fn verifier(e: &Env) -> Address {
        e.storage().instance().get(&StorageKey::Verifier).unwrap()
    }

    fn verify_proof(e: &Env, public_inputs: Bytes, proof: Bytes) -> bool {
        let mut args = Vec::new(e);
        args.push_back(public_inputs.into_val(e));
        args.push_back(proof.into_val(e));
        e.invoke_contract(&Self::verifier(e), &Symbol::new(e, "verify_proof"), args)
    }

    fn public_inputs(
        e: &Env,
        position_id: BytesN<32>,
        history_root: BytesN<32>,
        threshold: u32,
        proof_nullifier: BytesN<32>,
    ) -> Bytes {
        let mut out = Bytes::new(e);
        out.append(&Bytes::from_array(e, &position_id.to_array()));
        out.append(&Bytes::from_array(e, &history_root.to_array()));
        out.append(&Self::u128_field_bytes(e, threshold as u128));
        out.append(&Bytes::from_array(e, &proof_nullifier.to_array()));
        out
    }

    fn u128_field_bytes(e: &Env, value: u128) -> Bytes {
        let mut bytes = [0u8; 32];
        bytes[16..].copy_from_slice(&value.to_be_bytes());
        Bytes::from_array(e, &bytes)
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for RepaymentHistoryRegistryContract {}
