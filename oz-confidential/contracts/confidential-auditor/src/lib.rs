#![no_std]

use soroban_sdk::{contract, contractimpl, symbol_short, Address, BytesN, Env, Symbol, Vec};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::upgradeable;
use stellar_macros::{only_admin, only_role};
use stellar_tokens::confidential::auditor::{storage as auditor, ConfidentialAuditor};

const MANAGER_ROLE: Symbol = symbol_short!("manager");

#[contract]
pub struct ConfidentialAuditorContract;

#[contractimpl]
impl ConfidentialAuditorContract {
    pub fn __constructor(e: &Env, admin: Address, manager: Address) {
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
    }

    /// Admin-gated WASM upgrade. Keep the admin behind a timelocked multisig.
    #[only_admin]
    pub fn upgrade(e: &Env, new_wasm_hash: BytesN<32>) {
        upgradeable::upgrade(e, &new_wasm_hash);
    }
}

#[contractimpl(contracttrait)]
impl ConfidentialAuditor for ConfidentialAuditorContract {
    #[only_role(operator, "manager")]
    fn register_key(e: &Env, auditor_id: u32, point: BytesN<64>, operator: Address) {
        auditor::register_key(e, auditor_id, &point);
    }

    #[only_role(operator, "manager")]
    fn rotate_key(e: &Env, auditor_id: u32, new_point: BytesN<64>, operator: Address) {
        auditor::rotate_key(e, auditor_id, &new_point);
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for ConfidentialAuditorContract {}
