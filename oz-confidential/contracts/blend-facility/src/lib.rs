#![no_std]

//! Nyx Blend Facility
//!
//! The commercial supply side of Nyx. Instead of Nyx bootstrapping its own
//! lending pool, it borrows wholesale liquidity from a **Blend** pool and
//! re-lends it privately to anchors through the confidential credit line.
//!
//! Blend sees only this facility's *aggregate* position (a normal public
//! borrower); individual anchor amounts never touch Blend and stay in the
//! confidential-token layer. The risk waterfall is:
//!
//!   confidential anchor collateral  ->  Nyx facility collateral (here)  ->  Blend pool
//!
//! This contract is a thin, access-controlled adapter over the Blend pool's
//! `submit(from, spender, to, requests)` entrypoint. Blend request types
//! (from `blend-contracts-v2` `pool/src/pool/actions.rs`):
//!   Supply=0, Withdraw=1, SupplyCollateral=2, WithdrawCollateral=3,
//!   Borrow=4, Repay=5.

use soroban_sdk::{
    contract, contractevent, contractimpl, contracttype, symbol_short, Address, BytesN, Env,
    IntoVal, Symbol, Val, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::upgradeable;
use stellar_macros::{only_admin, only_role};

const MANAGER_ROLE: Symbol = symbol_short!("manager");

const RT_SUPPLY_COLLATERAL: u32 = 2;
const RT_WITHDRAW_COLLATERAL: u32 = 3;
const RT_BORROW: u32 = 4;
const RT_REPAY: u32 = 5;

// Mirror of Blend's `Request` (decoded by field name on the pool side).
#[contracttype]
#[derive(Clone)]
pub struct Request {
    pub request_type: u32,
    pub address: Address,
    pub amount: i128,
}

#[contracttype]
enum StorageKey {
    Pool,
    BorrowAsset,
}

#[contractevent(topics = ["FacilityBorrowed"])]
pub struct FacilityBorrowed {
    pub from: Address,
    pub to: Address,
    pub asset: Address,
    pub amount: i128,
}

#[contractevent(topics = ["FacilityRepaid"])]
pub struct FacilityRepaid {
    pub from: Address,
    pub asset: Address,
    pub amount: i128,
}

#[contractevent(topics = ["FacilityCollateral"])]
pub struct FacilityCollateral {
    pub from: Address,
    pub asset: Address,
    pub amount: i128,
    pub supplied: bool,
}

#[contract]
pub struct BlendFacilityContract;

#[contractimpl]
impl BlendFacilityContract {
    pub fn __constructor(
        e: &Env,
        admin: Address,
        manager: Address,
        blend_pool: Address,
        borrow_asset: Address,
    ) {
        access_control::set_admin(e, &admin);
        access_control::grant_role_no_auth(e, &manager, &MANAGER_ROLE, &admin);
        e.storage().instance().set(&StorageKey::Pool, &blend_pool);
        e.storage().instance().set(&StorageKey::BorrowAsset, &borrow_asset);
    }

    /// Post collateral into the Blend pool to back the facility's borrowing.
    /// `from` owns the Blend position and authorizes the transfer.
    #[only_role(operator, "manager")]
    pub fn supply_collateral(
        e: &Env,
        from: Address,
        asset: Address,
        amount: i128,
        operator: Address,
    ) {
        let _ = &operator;
        from.require_auth();
        Self::submit(e, &from, &from, &from, RT_SUPPLY_COLLATERAL, &asset, amount);
        FacilityCollateral { from, asset, amount, supplied: true }.publish(e);
    }

    /// Draw wholesale liquidity from Blend to fund private prefunding. Borrowed
    /// `borrow_asset` is sent to `to` (e.g. the facility treasury feeding the
    /// confidential cUSDC leg).
    #[only_role(operator, "manager")]
    pub fn borrow(e: &Env, from: Address, to: Address, amount: i128, operator: Address) {
        let _ = &operator;
        from.require_auth();
        let asset = Self::borrow_asset(e);
        Self::submit(e, &from, &from, &to, RT_BORROW, &asset, amount);
        FacilityBorrowed { from, to, asset, amount }.publish(e);
    }

    /// Repay wholesale debt to Blend (funded by anchor repayments).
    #[only_role(operator, "manager")]
    pub fn repay(e: &Env, from: Address, amount: i128, operator: Address) {
        let _ = &operator;
        from.require_auth();
        let asset = Self::borrow_asset(e);
        Self::submit(e, &from, &from, &from, RT_REPAY, &asset, amount);
        FacilityRepaid { from, asset, amount }.publish(e);
    }

    /// Withdraw facility collateral once wholesale debt is cleared.
    #[only_role(operator, "manager")]
    pub fn withdraw_collateral(
        e: &Env,
        from: Address,
        asset: Address,
        amount: i128,
        to: Address,
        operator: Address,
    ) {
        let _ = &operator;
        from.require_auth();
        Self::submit(e, &from, &from, &to, RT_WITHDRAW_COLLATERAL, &asset, amount);
        FacilityCollateral { from, asset, amount, supplied: false }.publish(e);
    }

    pub fn pool(e: &Env) -> Address {
        e.storage().instance().get(&StorageKey::Pool).unwrap()
    }

    pub fn borrow_asset(e: &Env) -> Address {
        e.storage().instance().get(&StorageKey::BorrowAsset).unwrap()
    }

    /// Admin-gated WASM upgrade. Keep the admin behind a timelocked multisig.
    #[only_admin]
    pub fn upgrade(e: &Env, new_wasm_hash: BytesN<32>) {
        upgradeable::upgrade(e, &new_wasm_hash);
    }

    // Builds a single-request Blend `submit` call.
    fn submit(
        e: &Env,
        from: &Address,
        spender: &Address,
        to: &Address,
        request_type: u32,
        asset: &Address,
        amount: i128,
    ) {
        let mut requests: Vec<Request> = Vec::new(e);
        requests.push_back(Request {
            request_type,
            address: asset.clone(),
            amount,
        });
        let mut args: Vec<Val> = Vec::new(e);
        args.push_back(from.into_val(e));
        args.push_back(spender.into_val(e));
        args.push_back(to.into_val(e));
        args.push_back(requests.into_val(e));
        // Blend returns `Positions`; we don't need it here.
        let _: Val = e.invoke_contract(&Self::pool(e), &Symbol::new(e, "submit"), args);
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for BlendFacilityContract {}
