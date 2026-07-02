#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    Env, Symbol, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_macros::only_role;

const MANAGER_ROLE: Symbol = symbol_short!("manager");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    MissingPrice = 4301,
    InvalidPrice = 4302,
    StalePrice = 4303,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price_e7: i128,
    pub updated_ledger: u32,
}

#[contracttype]
enum StorageKey {
    Price(Address),
}

#[contract]
pub struct OracleAdapterContract;

#[contractimpl]
impl OracleAdapterContract {
    pub fn __constructor(e: &Env, admin: Address, manager: Address) {
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
    }

    #[only_role(operator, "manager")]
    pub fn set_price(e: &Env, asset: Address, price_e7: i128, updated_ledger: u32, operator: Address) {
        if price_e7 <= 0 {
            panic_with_error!(e, OracleError::InvalidPrice);
        }
        e.storage()
            .persistent()
            .set(&StorageKey::Price(asset), &PriceData { price_e7, updated_ledger });
    }

    pub fn price(e: &Env, asset: Address) -> PriceData {
        e.storage()
            .persistent()
            .get(&StorageKey::Price(asset))
            .unwrap_or_else(|| {
                panic_with_error!(e, OracleError::MissingPrice);
            })
    }

    pub fn price_e7(e: &Env, asset: Address) -> i128 {
        Self::price(e, asset).price_e7
    }

    pub fn updated_ledger(e: &Env, asset: Address) -> u32 {
        Self::price(e, asset).updated_ledger
    }

    pub fn assert_fresh(e: &Env, asset: Address, max_staleness_ledgers: u32) {
        let price = Self::price(e, asset);
        if e.ledger().sequence().saturating_sub(price.updated_ledger) > max_staleness_ledgers {
            panic_with_error!(e, OracleError::StalePrice);
        }
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for OracleAdapterContract {}
