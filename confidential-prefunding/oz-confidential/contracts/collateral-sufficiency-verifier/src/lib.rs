#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, panic_with_error, symbol_short, Bytes, Env, Symbol};
use ultrahonk_soroban_verifier::{UltraHonkVerifier, VkLoadError, PROOF_BYTES};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VerifierError {
    VkInvalidLength = 4601,
    VkInvalidParameters = 4602,
    ProofParseError = 4603,
    VerificationFailed = 4604,
    VkNotSet = 4605,
    AlreadyInitialized = 4606,
}

#[contract]
pub struct CollateralSufficiencyVerifierContract;

#[contractimpl]
impl CollateralSufficiencyVerifierContract {
    fn key_vk() -> Symbol {
        symbol_short!("vk")
    }

    pub fn __constructor(e: &Env, vk_bytes: Bytes) {
        if e.storage().instance().has(&Self::key_vk()) {
            panic_with_error!(e, VerifierError::AlreadyInitialized);
        }
        Self::parse_verifier(e, &vk_bytes);
        e.storage().instance().set(&Self::key_vk(), &vk_bytes);
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
