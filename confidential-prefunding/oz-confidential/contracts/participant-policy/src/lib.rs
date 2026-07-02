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
pub enum ParticipantPolicyError {
    NotApproved = 4101,
    ApprovalExpired = 4102,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParticipantStatus {
    pub approved: bool,
    pub role_mask: u32,
    pub risk_tier: u32,
    pub expires_ledger: u32,
}

#[contracttype]
enum StorageKey {
    Participant(Address),
}

#[contract]
pub struct ParticipantPolicyContract;

#[contractimpl]
impl ParticipantPolicyContract {
    pub fn __constructor(e: &Env, admin: Address, manager: Address) {
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
    }

    #[only_role(operator, "manager")]
    pub fn set_participant(
        e: &Env,
        account: Address,
        approved: bool,
        role_mask: u32,
        risk_tier: u32,
        expires_ledger: u32,
        operator: Address,
    ) {
        e.storage().persistent().set(
            &StorageKey::Participant(account),
            &ParticipantStatus {
                approved,
                role_mask,
                risk_tier,
                expires_ledger,
            },
        );
    }

    pub fn status(e: &Env, account: Address) -> ParticipantStatus {
        e.storage()
            .persistent()
            .get(&StorageKey::Participant(account))
            .unwrap_or(ParticipantStatus {
                approved: false,
                role_mask: 0,
                risk_tier: 0,
                expires_ledger: 0,
            })
    }

    pub fn is_approved(e: &Env, account: Address) -> bool {
        let status = Self::status(e, account);
        status.approved && (status.expires_ledger == 0 || e.ledger().sequence() <= status.expires_ledger)
    }

    pub fn require_approved(e: &Env, account: Address) {
        let status = Self::status(e, account);
        if !status.approved {
            panic_with_error!(e, ParticipantPolicyError::NotApproved);
        }
        if status.expires_ledger != 0 && e.ledger().sequence() > status.expires_ledger {
            panic_with_error!(e, ParticipantPolicyError::ApprovalExpired);
        }
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for ParticipantPolicyContract {}
