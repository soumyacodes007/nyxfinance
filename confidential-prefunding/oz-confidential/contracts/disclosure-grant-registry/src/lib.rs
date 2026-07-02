#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, BytesN, Env, Symbol, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_macros::only_role;

const MANAGER_ROLE: Symbol = symbol_short!("manager");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum DisclosureGrantError {
    GrantAlreadyExists = 4901,
    GrantNotFound = 4902,
    GrantExpired = 4903,
    GrantRevoked = 4904,
    ViewerMismatch = 4905,
    ScopeMismatch = 4906,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DisclosureGrant {
    pub grant_id: BytesN<32>,
    pub owner: Address,
    pub viewer_hash: BytesN<32>,
    pub position_id: BytesN<32>,
    pub event_hash: BytesN<32>,
    pub scope_hash: BytesN<32>,
    pub bundle_hash: BytesN<32>,
    pub expires_at_ledger: u32,
    pub revoked: bool,
    pub created_at_ledger: u32,
}

#[contractevent(topics = ["DisclosureGrantCreated"])]
pub struct DisclosureGrantCreated {
    pub grant_id: BytesN<32>,
    pub owner: Address,
    pub viewer_hash: BytesN<32>,
    pub position_id: BytesN<32>,
    pub event_hash: BytesN<32>,
    pub scope_hash: BytesN<32>,
    pub bundle_hash: BytesN<32>,
    pub expires_at_ledger: u32,
}

#[contractevent(topics = ["DisclosureGrantRevoked"])]
pub struct DisclosureGrantRevoked {
    pub grant_id: BytesN<32>,
    pub revoked_at_ledger: u32,
}

#[contracttype]
enum StorageKey {
    Grant(BytesN<32>),
}

#[contract]
pub struct DisclosureGrantRegistryContract;

#[contractimpl]
impl DisclosureGrantRegistryContract {
    pub fn __constructor(e: &Env, admin: Address, manager: Address) {
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
    }

    #[allow(clippy::too_many_arguments)]
    #[only_role(operator, "manager")]
    pub fn create_grant(
        e: &Env,
        grant_id: BytesN<32>,
        owner: Address,
        viewer_hash: BytesN<32>,
        position_id: BytesN<32>,
        event_hash: BytesN<32>,
        scope_hash: BytesN<32>,
        bundle_hash: BytesN<32>,
        expires_at_ledger: u32,
        operator: Address,
    ) {
        if e.storage().persistent().has(&StorageKey::Grant(grant_id.clone())) {
            panic_with_error!(e, DisclosureGrantError::GrantAlreadyExists);
        }
        let grant = DisclosureGrant {
            grant_id: grant_id.clone(),
            owner: owner.clone(),
            viewer_hash: viewer_hash.clone(),
            position_id: position_id.clone(),
            event_hash: event_hash.clone(),
            scope_hash: scope_hash.clone(),
            bundle_hash: bundle_hash.clone(),
            expires_at_ledger,
            revoked: false,
            created_at_ledger: e.ledger().sequence(),
        };
        e.storage()
            .persistent()
            .set(&StorageKey::Grant(grant_id.clone()), &grant);
        DisclosureGrantCreated {
            grant_id,
            owner,
            viewer_hash,
            position_id,
            event_hash,
            scope_hash,
            bundle_hash,
            expires_at_ledger,
        }
        .publish(e);
    }

    #[only_role(operator, "manager")]
    pub fn revoke_grant(e: &Env, grant_id: BytesN<32>, operator: Address) {
        let mut grant = Self::get_grant(e, grant_id.clone());
        grant.revoked = true;
        e.storage()
            .persistent()
            .set(&StorageKey::Grant(grant_id.clone()), &grant);
        DisclosureGrantRevoked {
            grant_id,
            revoked_at_ledger: e.ledger().sequence(),
        }
        .publish(e);
    }

    pub fn get_grant(e: &Env, grant_id: BytesN<32>) -> DisclosureGrant {
        e.storage()
            .persistent()
            .get(&StorageKey::Grant(grant_id))
            .unwrap_or_else(|| panic_with_error!(e, DisclosureGrantError::GrantNotFound))
    }

    pub fn is_valid(
        e: &Env,
        grant_id: BytesN<32>,
        viewer_hash: BytesN<32>,
        scope_hash: BytesN<32>,
    ) -> bool {
        let grant = Self::get_grant(e, grant_id);
        !grant.revoked
            && e.ledger().sequence() <= grant.expires_at_ledger
            && grant.viewer_hash == viewer_hash
            && grant.scope_hash == scope_hash
    }

    pub fn require_valid(
        e: &Env,
        grant_id: BytesN<32>,
        viewer_hash: BytesN<32>,
        scope_hash: BytesN<32>,
    ) {
        let grant = Self::get_grant(e, grant_id);
        if grant.revoked {
            panic_with_error!(e, DisclosureGrantError::GrantRevoked);
        }
        if e.ledger().sequence() > grant.expires_at_ledger {
            panic_with_error!(e, DisclosureGrantError::GrantExpired);
        }
        if grant.viewer_hash != viewer_hash {
            panic_with_error!(e, DisclosureGrantError::ViewerMismatch);
        }
        if grant.scope_hash != scope_hash {
            panic_with_error!(e, DisclosureGrantError::ScopeMismatch);
        }
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for DisclosureGrantRegistryContract {}
