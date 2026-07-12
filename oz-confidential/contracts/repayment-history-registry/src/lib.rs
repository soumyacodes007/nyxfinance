#![no_std]

use soroban_poseidon::Poseidon2Sponge;
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Bytes, BytesN, Env, IntoVal, Symbol, Vec, U256,
    crypto::bn254::Bn254Fr,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::upgradeable;
use stellar_macros::{only_admin, only_role};

const MANAGER_ROLE: Symbol = symbol_short!("manager");
// Must match `circuits/repayment_history/src/main.nr`'s
// `DOMAIN_REPAYMENT_ROOT`. The root is computed on-chain (not operator
// supplied) from the leaves actually seeded, using the identical
// domain-separated Poseidon2 sponge the circuit uses, so a proof that
// verifies against this root necessarily opens these exact seeded leaves.
const DOMAIN_REPAYMENT_ROOT: u32 = 41;
// The circuit is a fixed 3-leaf design (`repayment_amount_0/1/2`, ...).
const LEAVES_PER_POSITION: u32 = 3;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RepaymentHistoryError {
    DuplicateLeaf = 4701,
    DuplicateProofNullifier = 4702,
    HistoryRootNotSet = 4703,
    ProofVerificationFailed = 4704,
    PublicInputsMismatch = 4705,
    LeafNotFound = 4706,
    TooManyLeaves = 4707,
    IncompleteLeafSet = 4708,
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
    // Leaf nullifiers seeded for a position, in insertion order. Bounds the
    // root computation to leaves that were actually recorded on-chain by
    // `seed_leaf` -- closing the gap where `set_history_root` used to accept
    // an arbitrary, disconnected root (C3).
    PositionLeaves(BytesN<32>),
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

    /// Admin-gated WASM upgrade. Keep the admin behind a timelocked multisig.
    #[only_admin]
    pub fn upgrade(e: &Env, new_wasm_hash: BytesN<32>) {
        upgradeable::upgrade(e, &new_wasm_hash);
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
        let leaves_key = StorageKey::PositionLeaves(position_id.clone());
        let mut leaves: Vec<BytesN<32>> = e
            .storage()
            .persistent()
            .get(&leaves_key)
            .unwrap_or_else(|| Vec::new(e));
        if leaves.len() >= LEAVES_PER_POSITION {
            panic_with_error!(e, RepaymentHistoryError::TooManyLeaves);
        }
        leaves.push_back(leaf_nullifier.clone());
        e.storage().persistent().set(&leaves_key, &leaves);

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

    /// Derives the history root **on-chain** from the leaves actually seeded
    /// for `position_id` via `seed_leaf` -- the operator no longer supplies
    /// the root directly (C3 fix). Requires exactly `LEAVES_PER_POSITION`
    /// seeded leaves, matching the circuit's fixed 3-leaf design. The root
    /// is `poseidon_with_domain(DOMAIN_REPAYMENT_ROOT, [position_id, leaf_0,
    /// leaf_1, leaf_2])`, identical to `circuits/repayment_history`'s
    /// `derived_root` -- so a proof can only verify against this root by
    /// opening these exact seeded leaves, not arbitrary self-attested ones.
    #[only_role(operator, "manager")]
    pub fn finalize_history_root(e: &Env, position_id: BytesN<32>, operator: Address) {
        let leaves: Vec<BytesN<32>> = e
            .storage()
            .persistent()
            .get(&StorageKey::PositionLeaves(position_id.clone()))
            .unwrap_or_else(|| Vec::new(e));
        if leaves.len() != LEAVES_PER_POSITION {
            panic_with_error!(e, RepaymentHistoryError::IncompleteLeafSet);
        }

        let mut inputs = Vec::new(e);
        inputs.push_back(bytes32_to_u256(e, &position_id));
        for leaf_nullifier in leaves.iter() {
            inputs.push_back(bytes32_to_u256(e, &leaf_nullifier));
        }
        let history_root = poseidon_with_domain(e, DOMAIN_REPAYMENT_ROOT, inputs);
        let leaf_count = leaves.len();

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
            .unwrap_or_else(|| panic_with_error!(e, RepaymentHistoryError::LeafNotFound))
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

fn bytes32_to_u256(e: &Env, value: &BytesN<32>) -> U256 {
    U256::from_be_bytes(e, &Bytes::from_array(e, &value.to_array()))
}

fn u256_to_bytes32(e: &Env, value: &U256) -> BytesN<32> {
    let bytes = value.to_be_bytes();
    let mut out = [0u8; 32];
    bytes.copy_into_slice(&mut out);
    BytesN::from_array(e, &out)
}

// Domain-separated Poseidon2 sponge, matching `circuits/lib/src/lib.nr`'s
// `poseidon_with_domain` bit-for-bit: the domain tag is absorbed first,
// followed by `inputs`, over the Barretenberg-compatible BN254 sponge
// (rate 3, capacity IV = len << 64).
fn poseidon_with_domain(e: &Env, domain: u32, inputs: Vec<U256>) -> BytesN<32> {
    let mut all: Vec<U256> = Vec::new(e);
    all.push_back(U256::from_u32(e, domain));
    for input in inputs.iter() {
        all.push_back(input);
    }
    let out = Poseidon2Sponge::<4, Bn254Fr>::new(e).compute_hash(&all);
    u256_to_bytes32(e, &out)
}
