#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, Address,
    BytesN, Env, IntoVal, Symbol, Val, Vec,
};
use stellar_access::access_control::{self as access_control, AccessControl};
use stellar_contract_utils::upgradeable;
use stellar_macros::{only_admin, only_role};

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

// Mirrors of the Reflector / SEP-40 oracle types, decoded by variant/field name
// from the on-chain feed. `Asset::Stellar(Address)` selects a Stellar asset by
// its contract address; `ReflectorPrice` is Reflector's `PriceData`.
#[contracttype]
#[derive(Clone)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone)]
pub struct ReflectorPrice {
    pub price: i128,
    pub timestamp: u64,
}

#[contract]
pub struct OracleAdapterContract;

#[contractimpl]
impl OracleAdapterContract {
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
    pub fn set_price(e: &Env, asset: Address, price_e7: i128, updated_ledger: u32, operator: Address) {
        if price_e7 <= 0 {
            panic_with_error!(e, OracleError::InvalidPrice);
        }
        // Reject future-dated updates. A timestamp ahead of the current ledger
        // would make staleness checks compute to zero forever, permanently
        // bypassing freshness enforcement in the credit line.
        if updated_ledger > e.ledger().sequence() {
            panic_with_error!(e, OracleError::InvalidPrice);
        }
        e.storage()
            .persistent()
            .set(&StorageKey::Price(asset), &PriceData { price_e7, updated_ledger });
    }

    /// Pull a live price from a Reflector (SEP-40) feed and store it, stamping
    /// the current ledger as the update point so freshness is measured from when
    /// Nyx last refreshed. The Reflector feed address and the asset are supplied
    /// by the caller (mainnet feed: CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN).
    #[only_role(operator, "manager")]
    pub fn refresh_from_reflector(
        e: &Env,
        asset: Address,
        reflector: Address,
        operator: Address,
    ) {
        let mut args: Vec<Val> = Vec::new(e);
        args.push_back(Asset::Stellar(asset.clone()).into_val(e));
        let latest: Option<ReflectorPrice> =
            e.invoke_contract(&reflector, &Symbol::new(e, "lastprice"), args);
        let latest = latest.unwrap_or_else(|| panic_with_error!(e, OracleError::MissingPrice));

        let decimals: u32 =
            e.invoke_contract(&reflector, &Symbol::new(e, "decimals"), Vec::new(e));
        let price_e7 = Self::to_e7(latest.price, decimals);
        if price_e7 <= 0 {
            panic_with_error!(e, OracleError::InvalidPrice);
        }
        e.storage().persistent().set(
            &StorageKey::Price(asset),
            &PriceData { price_e7, updated_ledger: e.ledger().sequence() },
        );
    }

    /// Same as `refresh_from_reflector`, but selects the Reflector price by a
    /// ticker symbol (`Asset::Other(symbol)`, e.g. "BTC"/"XLM"/"USDC") instead of
    /// a Stellar asset address, and stores it under the local `asset` key. Needed
    /// because Reflector's CEX/DEX feeds quote by symbol, not by contract address.
    #[only_role(operator, "manager")]
    pub fn refresh_from_reflector_symbol(
        e: &Env,
        asset: Address,
        reflector: Address,
        symbol: Symbol,
        operator: Address,
    ) {
        let mut args: Vec<Val> = Vec::new(e);
        args.push_back(Asset::Other(symbol).into_val(e));
        let latest: Option<ReflectorPrice> =
            e.invoke_contract(&reflector, &Symbol::new(e, "lastprice"), args);
        let latest = latest.unwrap_or_else(|| panic_with_error!(e, OracleError::MissingPrice));

        let decimals: u32 =
            e.invoke_contract(&reflector, &Symbol::new(e, "decimals"), Vec::new(e));
        let price_e7 = Self::to_e7(latest.price, decimals);
        if price_e7 <= 0 {
            panic_with_error!(e, OracleError::InvalidPrice);
        }
        e.storage().persistent().set(
            &StorageKey::Price(asset),
            &PriceData { price_e7, updated_ledger: e.ledger().sequence() },
        );
    }

    // Rescales a Reflector price (10^decimals) to the 10^7 fixed-point this
    // adapter exposes.
    fn to_e7(price: i128, decimals: u32) -> i128 {
        if decimals >= 7 {
            price / 10i128.pow(decimals - 7)
        } else {
            price * 10i128.pow(7 - decimals)
        }
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
