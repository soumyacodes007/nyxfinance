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
pub enum CollateralPolicyError {
    InvalidHaircut = 4201,
    InvalidTenor = 4202,
    IneligibleCollateral = 4203,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollateralPolicy {
    pub eligible: bool,
    pub haircut_bps: u32,
    pub max_tenor_days: u32,
    pub oracle: Address,
    pub max_staleness_ledgers: u32,
}

#[contracttype]
enum StorageKey {
    Policy(Address),
}

#[contract]
pub struct CollateralPolicyRegistryContract;

#[contractimpl]
impl CollateralPolicyRegistryContract {
    pub fn __constructor(e: &Env, admin: Address, manager: Address) {
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
    }

    #[allow(clippy::too_many_arguments)]
    #[only_role(operator, "manager")]
    pub fn set_policy(
        e: &Env,
        collateral_token: Address,
        eligible: bool,
        haircut_bps: u32,
        max_tenor_days: u32,
        oracle: Address,
        max_staleness_ledgers: u32,
        operator: Address,
    ) {
        if haircut_bps > 10_000 {
            panic_with_error!(e, CollateralPolicyError::InvalidHaircut);
        }
        if max_tenor_days == 0 || max_tenor_days > 5 {
            panic_with_error!(e, CollateralPolicyError::InvalidTenor);
        }
        e.storage().persistent().set(
            &StorageKey::Policy(collateral_token),
            &CollateralPolicy {
                eligible,
                haircut_bps,
                max_tenor_days,
                oracle,
                max_staleness_ledgers,
            },
        );
    }

    pub fn policy(e: &Env, collateral_token: Address) -> CollateralPolicy {
        e.storage()
            .persistent()
            .get(&StorageKey::Policy(collateral_token.clone()))
            .unwrap_or_else(|| {
                panic_with_error!(e, CollateralPolicyError::IneligibleCollateral);
            })
    }

    pub fn is_eligible(e: &Env, collateral_token: Address) -> bool {
        Self::policy(e, collateral_token).eligible
    }

    pub fn haircut_bps(e: &Env, collateral_token: Address) -> u32 {
        Self::policy(e, collateral_token).haircut_bps
    }

    pub fn max_tenor_days(e: &Env, collateral_token: Address) -> u32 {
        Self::policy(e, collateral_token).max_tenor_days
    }

    pub fn oracle(e: &Env, collateral_token: Address) -> Address {
        Self::policy(e, collateral_token).oracle
    }

    pub fn max_staleness_ledgers(e: &Env, collateral_token: Address) -> u32 {
        Self::policy(e, collateral_token).max_staleness_ledgers
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for CollateralPolicyRegistryContract {}
