#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, Symbol, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::upgradeable;
use stellar_macros::{only_admin, only_role};

const MANAGER_ROLE: Symbol = symbol_short!("manager");
const LEDGERS_PER_DAY: u32 = 17_280;
// Locks must outlive the maximum tenor (5 days) with generous headroom so the
// replay/reuse guard is never archived while a position is live.
const LOCK_TTL_THRESHOLD: u32 = LEDGERS_PER_DAY * 7;
const LOCK_TTL_EXTEND_TO: u32 = LEDGERS_PER_DAY * 60;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum CollateralLockError {
    AlreadyLocked = 4401,
    LockNotFound = 4402,
    CollateralLocked = 4403,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollateralLock {
    pub active: bool,
    pub owner: Address,
    pub collateral_token: Address,
    pub position_id: BytesN<32>,
    pub expiry_ledger: u32,
}

#[contracttype]
enum StorageKey {
    Lock(BytesN<32>),
}

#[contract]
pub struct CollateralLockRegistryContract;

#[contractimpl]
impl CollateralLockRegistryContract {
    pub fn __constructor(e: &Env, admin: Address, manager: Address) {
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
    }

    /// Admin-gated WASM upgrade. Keep the admin behind a timelocked multisig.
    #[only_admin]
    pub fn upgrade(e: &Env, new_wasm_hash: BytesN<32>) {
        upgradeable::upgrade(e, &new_wasm_hash);
    }

    #[allow(clippy::too_many_arguments)]
    #[only_role(operator, "manager")]
    pub fn lock(
        e: &Env,
        lock_key: BytesN<32>,
        owner: Address,
        collateral_token: Address,
        position_id: BytesN<32>,
        expiry_ledger: u32,
        operator: Address,
    ) {
        if Self::is_locked(e, lock_key.clone()) {
            panic_with_error!(e, CollateralLockError::AlreadyLocked);
        }
        let key = StorageKey::Lock(lock_key);
        e.storage().persistent().set(
            &key,
            &CollateralLock {
                active: true,
                owner,
                collateral_token,
                position_id,
                expiry_ledger,
            },
        );
        // Keep the lock (replay/collateral-reuse guard) alive for the full
        // credit lifecycle; without this the entry could be archived and evicted.
        e.storage()
            .persistent()
            .extend_ttl(&key, LOCK_TTL_THRESHOLD, LOCK_TTL_EXTEND_TO);
    }

    #[only_role(operator, "manager")]
    pub fn release(e: &Env, lock_key: BytesN<32>, operator: Address) {
        let mut lock = Self::get_lock(e, lock_key.clone());
        lock.active = false;
        e.storage().persistent().set(&StorageKey::Lock(lock_key), &lock);
    }

    pub fn get_lock(e: &Env, lock_key: BytesN<32>) -> CollateralLock {
        e.storage()
            .persistent()
            .get(&StorageKey::Lock(lock_key))
            .unwrap_or_else(|| {
                panic_with_error!(e, CollateralLockError::LockNotFound);
            })
    }

    pub fn is_locked(e: &Env, lock_key: BytesN<32>) -> bool {
        e.storage()
            .persistent()
            .get::<_, CollateralLock>(&StorageKey::Lock(lock_key))
            .map(|lock| lock.active)
            .unwrap_or(false)
    }

    pub fn assert_revoke_allowed(e: &Env, lock_key: BytesN<32>) {
        if Self::is_locked(e, lock_key) {
            panic_with_error!(e, CollateralLockError::CollateralLocked);
        }
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for CollateralLockRegistryContract {}
