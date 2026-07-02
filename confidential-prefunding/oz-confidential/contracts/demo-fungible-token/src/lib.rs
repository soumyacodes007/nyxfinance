#![no_std]

use soroban_sdk::{
    contract, contractimpl, symbol_short, Address, Env, MuxedAddress, String, Symbol, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_macros::only_role;
use stellar_tokens::fungible::{Base, FungibleToken};

const MANAGER_ROLE: Symbol = symbol_short!("manager");

#[contract]
pub struct DemoFungibleTokenContract;

#[contractimpl]
impl DemoFungibleTokenContract {
    pub fn __constructor(
        e: &Env,
        admin: Address,
        manager: Address,
        decimals: u32,
        name: String,
        symbol: String,
    ) {
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
        Base::set_metadata(e, decimals, name, symbol);
    }

    #[only_role(operator, "manager")]
    pub fn mint(e: &Env, to: Address, amount: i128, operator: Address) {
        Base::mint(e, &to, amount);
    }
}

#[contractimpl(contracttrait)]
impl FungibleToken for DemoFungibleTokenContract {
    type ContractType = Base;

    fn total_supply(e: &Env) -> i128 {
        Self::ContractType::total_supply(e)
    }

    fn balance(e: &Env, account: Address) -> i128 {
        Self::ContractType::balance(e, &account)
    }

    fn allowance(e: &Env, owner: Address, spender: Address) -> i128 {
        Self::ContractType::allowance(e, &owner, &spender)
    }

    fn transfer(e: &Env, from: Address, to: MuxedAddress, amount: i128) {
        Self::ContractType::transfer(e, &from, &to, amount);
    }

    fn transfer_from(e: &Env, spender: Address, from: Address, to: Address, amount: i128) {
        Self::ContractType::transfer_from(e, &spender, &from, &to, amount);
    }

    fn approve(e: &Env, owner: Address, spender: Address, amount: i128, live_until_ledger: u32) {
        Self::ContractType::approve(e, &owner, &spender, amount, live_until_ledger);
    }

    fn decimals(e: &Env) -> u32 {
        Self::ContractType::decimals(e)
    }

    fn name(e: &Env) -> String {
        Self::ContractType::name(e)
    }

    fn symbol(e: &Env) -> String {
        Self::ContractType::symbol(e)
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for DemoFungibleTokenContract {}
