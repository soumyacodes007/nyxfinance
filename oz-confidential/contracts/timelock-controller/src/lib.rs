#![no_std]

//! Nyx Timelock Controller.
//!
//! Reuses OpenZeppelin's `stellar-contracts` `timelock-controller` example
//! verbatim (role-based proposer/executor/canceller timelock over
//! `stellar_governance::timelock::Timelock`) as the admin for Nyx's
//! mainnet-facing contracts (`prefunding-credit-line`, lock registry, oracle
//! adapter, repayment-history registry), addressing the "admin behind a
//! timelocked multisig" mainnet gate: schedule an admin operation (pause,
//! upgrade, role change), wait out `min_delay` ledgers, then execute it.
//! `proposers` should be the set of individuals who can propose changes
//! (their own accounts, or a Stellar classic multisig account for an
//! additional signer-threshold layer); `min_delay` should be sized for
//! mainnet (multi-day) review windows, not the short demo delay used for
//! testnet validation.

use soroban_sdk::{
    auth::{Context, ContractContext, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    panic_with_error, symbol_short, Address, BytesN, Env, IntoVal, Symbol, Val, Vec,
};
use stellar_access::access_control::{
    ensure_role, get_role_member_count, grant_role_no_auth, set_admin, AccessControl,
};
use stellar_contract_utils::upgradeable;
use stellar_governance::timelock::{
    cancel_operation, execute_operation, schedule_operation, set_execute_operation,
    set_min_delay as timelock_set_min_delay, Operation, OperationState, Timelock, TimelockError,
};
use stellar_macros::{only_admin, only_role};

#[contracterror]
#[repr(u32)]
enum TimelockControllerError {
    Mismatch = 0,
}

const PROPOSER_ROLE: Symbol = symbol_short!("proposer");
const EXECUTOR_ROLE: Symbol = symbol_short!("executor");
const CANCELLER_ROLE: Symbol = symbol_short!("canceller");

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OperationMeta {
    pub predecessor: BytesN<32>,
    pub salt: BytesN<32>,
    pub executor: Option<Address>,
}

#[contract]
pub struct TimelockController;

#[contractimpl]
impl CustomAccountInterface for TimelockController {
    type Error = TimelockError;
    type Signature = Vec<OperationMeta>;

    fn __check_auth(
        e: Env,
        _signature_payload: Hash<32>,
        context_meta: Vec<OperationMeta>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Self::Error> {
        if auth_contexts.len() != context_meta.len() {
            panic_with_error!(&e, TimelockControllerError::Mismatch);
        }
        for (context, meta) in auth_contexts.iter().zip(context_meta) {
            match context.clone() {
                Context::Contract(ContractContext { contract, fn_name, args }) => {
                    if contract != e.current_contract_address() {
                        panic_with_error!(&e, TimelockError::Unauthorized)
                    }

                    if get_role_member_count(&e, &EXECUTOR_ROLE) != 0 {
                        let args_for_auth = (
                            Symbol::new(&e, "execute_op"),
                            contract.clone(),
                            fn_name.clone(),
                            args.clone(),
                            meta.predecessor.clone(),
                            meta.salt.clone(),
                        )
                            .into_val(&e);

                        let executor = meta.executor.expect("Executor must be present");

                        ensure_role(&e, &EXECUTOR_ROLE, &executor);
                        executor.require_auth_for_args(args_for_auth);
                    }

                    let op = Operation {
                        target: contract,
                        function: fn_name,
                        args,
                        predecessor: meta.predecessor,
                        salt: meta.salt,
                    };
                    set_execute_operation(&e, &op);
                }
                _ => panic_with_error!(&e, TimelockError::Unauthorized),
            }
        }
        Ok(())
    }
}

#[contractimpl]
impl TimelockController {
    pub fn __constructor(
        e: &Env,
        min_delay: u32,
        proposers: Vec<Address>,
        executors: Vec<Address>,
        admin: Option<Address>,
    ) {
        let admin_addr = match admin {
            Some(admin_addr) => admin_addr,
            _ => e.current_contract_address(),
        };
        set_admin(e, &admin_addr);

        for proposer in proposers.iter() {
            grant_role_no_auth(e, &proposer, &PROPOSER_ROLE, &admin_addr);
            grant_role_no_auth(e, &proposer, &CANCELLER_ROLE, &admin_addr);
        }

        for executor in executors.iter() {
            grant_role_no_auth(e, &executor, &EXECUTOR_ROLE, &admin_addr);
        }

        timelock_set_min_delay(e, min_delay);
    }

    /// Self-administered WASM upgrade: since this contract is its own admin
    /// (`__check_auth` above), `only_admin`'s `require_auth()` here routes
    /// through the SAME schedule -> wait out min_delay -> execute flow as
    /// every other admin operation (e.g. `update_delay`) -- there is no
    /// direct/instant path to change this contract's own code, even for
    /// whoever holds a proposer/executor key.
    #[only_admin]
    pub fn upgrade(e: &Env, new_wasm_hash: BytesN<32>) {
        upgradeable::upgrade(e, &new_wasm_hash);
    }
}

#[contractimpl(contracttrait)]
impl Timelock for TimelockController {
    #[allow(clippy::too_many_arguments)]
    #[only_role(proposer, "proposer")]
    fn schedule(
        e: &Env,
        target: Address,
        function: Symbol,
        args: Vec<Val>,
        predecessor: BytesN<32>,
        salt: BytesN<32>,
        delay: u32,
        proposer: Address,
    ) -> BytesN<32> {
        let operation = Operation { target, function, args, predecessor, salt };
        schedule_operation(e, &operation, delay)
    }

    fn execute(
        e: &Env,
        target: Address,
        function: Symbol,
        args: Vec<Val>,
        predecessor: BytesN<32>,
        salt: BytesN<32>,
        executor: Option<Address>,
    ) -> Val {
        if get_role_member_count(e, &EXECUTOR_ROLE) != 0 {
            let executor = executor.expect("to be present");
            ensure_role(e, &EXECUTOR_ROLE, &executor);
            executor.require_auth();
        }

        let operation = Operation { target, function, args, predecessor, salt };
        execute_operation(e, &operation)
    }

    #[only_role(canceller, "canceller")]
    fn cancel(e: &Env, operation_id: BytesN<32>, canceller: Address) {
        cancel_operation(e, &operation_id);
    }

    #[only_admin]
    fn update_delay(e: &Env, new_delay: u32, _operator: Address) {
        timelock_set_min_delay(e, new_delay);
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for TimelockController {}
