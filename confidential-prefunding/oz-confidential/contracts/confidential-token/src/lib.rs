#![no_std]

use soroban_sdk::{contract, contractimpl, symbol_short, xdr::ToXdr, Address, Bytes, Env, Symbol, Vec};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_macros::only_role;
use stellar_tokens::confidential::{
    ConfidentialAccount,
    compliance::{
        storage as compliance_storage,
        ComplianceConfig,
        ComplianceHooks,
        ConfidentialCompliance,
    },
    storage as confidential_storage,
    ConfidentialToken, SpenderDelegation,
};

const MANAGER_ROLE: Symbol = symbol_short!("manager");

#[contract]
pub struct ConfidentialTokenContract;

#[contractimpl]
impl ConfidentialTokenContract {
    pub fn __constructor(
        e: &Env,
        admin: Address,
        manager: Address,
        underlying_asset: Address,
        verifier: Address,
        auditor: Address,
        policy: Address,
    ) {
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);

        confidential_storage::set_underlying_asset(e, &underlying_asset);
        confidential_storage::set_verifier(e, &verifier);
        confidential_storage::set_auditor(e, &auditor);
        confidential_storage::set_address_as_field_element(e);

        compliance_storage::set_compliance_config(
            e,
            &ComplianceConfig {
                policy: Some(policy),
                sac_passthrough: false,
            },
        );
    }

    pub fn confidential_balance_xdr(e: &Env, account: Address) -> Bytes {
        confidential_storage::get_account(e, &account).to_xdr(e)
    }

    pub fn spender_delegation_xdr(e: &Env, account: Address, spender: Address) -> Bytes {
        confidential_storage::get_spender_delegation(e, &account, &spender).to_xdr(e)
    }
}

#[contractimpl(contracttrait)]
impl ConfidentialToken for ConfidentialTokenContract {
    type Hooks = ComplianceHooks;
}

#[contractimpl(contracttrait)]
impl ConfidentialCompliance for ConfidentialTokenContract {
    #[only_role(operator, "manager")]
    fn freeze(e: &Env, account: Address, operator: Address) {
        compliance_storage::freeze(e, &account);
    }

    #[only_role(operator, "manager")]
    fn unfreeze(e: &Env, account: Address, operator: Address) {
        compliance_storage::unfreeze(e, &account);
    }

    #[only_role(operator, "manager")]
    fn set_compliance_config(e: &Env, config: ComplianceConfig, operator: Address) {
        compliance_storage::set_compliance_config(e, &config);
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for ConfidentialTokenContract {}
