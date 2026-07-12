#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, panic_with_error, symbol_short, Address, Bytes, BytesN, Env,
    Symbol, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::upgradeable;
use stellar_macros::only_admin;
use ultrahonk_soroban_verifier::{UltraHonkVerifier, VkLoadError, PROOF_BYTES};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VerifierError {
    VkInvalidLength = 4801,
    VkInvalidParameters = 4802,
    ProofParseError = 4803,
    VerificationFailed = 4804,
    VkNotSet = 4805,
    AlreadyInitialized = 4806,
}

#[contract]
pub struct RepaymentHistoryVerifierContract;

#[contractimpl]
impl RepaymentHistoryVerifierContract {
    fn key_vk() -> Symbol {
        symbol_short!("vk")
    }

    pub fn __constructor(e: &Env, admin: Address, vk_bytes: Bytes) {
        if e.storage().instance().has(&Self::key_vk()) {
            panic_with_error!(e, VerifierError::AlreadyInitialized);
        }
        access_control::set_admin(e, &admin);
        Self::parse_verifier(e, &vk_bytes);
        e.storage().instance().set(&Self::key_vk(), &vk_bytes);
    }

    /// Admin-gated WASM upgrade. Keep the admin behind a timelocked multisig
    /// -- this contract is the ZK trust root, so a compromised admin here
    /// could swap in a verifier that accepts fraudulent proofs. The same
    /// timelock delay that protects the other contracts applies here too.
    #[only_admin]
    pub fn upgrade(e: &Env, new_wasm_hash: BytesN<32>) {
        upgradeable::upgrade(e, &new_wasm_hash);
    }

    pub fn vk_bytes(e: &Env) -> Bytes {
        e.storage()
            .instance()
            .get(&Self::key_vk())
            .unwrap_or_else(|| panic_with_error!(e, VerifierError::VkNotSet))
    }

    pub fn verify_proof(e: &Env, public_inputs: Bytes, proof: Bytes) -> bool {
        if proof.len() as usize != PROOF_BYTES {
            return false;
        }
        let vk = Self::vk_bytes(e);
        let verifier = Self::parse_verifier(e, &vk);
        verifier.verify(e, &proof, &public_inputs).is_ok()
    }

    fn parse_verifier(e: &Env, vk_bytes: &Bytes) -> UltraHonkVerifier {
        UltraHonkVerifier::new(e, vk_bytes).unwrap_or_else(|err| match err {
            VkLoadError::WrongLength => panic_with_error!(e, VerifierError::VkInvalidLength),
            VkLoadError::InvalidParameters => {
                panic_with_error!(e, VerifierError::VkInvalidParameters)
            }
        })
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for RepaymentHistoryVerifierContract {}
