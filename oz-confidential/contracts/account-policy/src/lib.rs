#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, BytesN, Env, Symbol, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::upgradeable;
use stellar_macros::{only_admin, only_role};

const MANAGER_ROLE: Symbol = symbol_short!("manager");

#[contracttype]
enum StorageKey {
    Blocked(Address),
}

#[contract]
pub struct AccountPolicyContract;

#[contractimpl]
impl AccountPolicyContract {
    pub fn __constructor(e: &Env, admin: Address, manager: Address) {
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
    }

    /// Admin-gated WASM upgrade. Keep the admin behind a timelocked multisig.
    #[only_admin]
    pub fn upgrade(e: &Env, new_wasm_hash: BytesN<32>) {
        upgradeable::upgrade(e, &new_wasm_hash);
    }

    #[only_role(operator, "manager")]
    pub fn set_blocked(e: &Env, account: Address, blocked: bool, operator: Address) {
        let key = StorageKey::Blocked(account);
        if blocked {
            e.storage().persistent().set(&key, &true);
        } else {
            e.storage().persistent().remove(&key);
        }
    }

    pub fn is_blocked(e: &Env, account: Address) -> bool {
        e.storage()
            .persistent()
            .get::<_, bool>(&StorageKey::Blocked(account))
            .unwrap_or(false)
    }
}

#[contractimpl]
impl AccountPolicyContract {
    pub fn is_authorized(e: Env, account: Address, _token: Address) -> bool {
        !Self::is_blocked(&e, account)
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for AccountPolicyContract {}
