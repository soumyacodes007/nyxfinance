use anyhow::{anyhow, bail, Context, Result};
use num_bigint::BigUint;
use num_traits::{One, Zero};
use serde::Serialize;
use serde_json::{json, Value};
use soroban_poseidon::{poseidon2_hash, Field as PoseidonField, Poseidon2Config, Poseidon2Sponge};
use soroban_sdk::{
    crypto::bn254::Bn254Fr,
    xdr::ToXdr,
    Bytes, BytesN, Env, U256,
};
use stellar_contract_utils::crypto::grumpkin::{Grumpkin, Point};
use stellar_tokens::confidential::{
    RegisterData, RegisterPayload, RevokeSpenderData, RevokeSpenderPayload, SetSpenderData,
    SetSpenderPayload, SpenderTransferData, SpenderTransferPayload, TransferData, TransferPayload,
};
use std::{
    collections::BTreeMap,
    env,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    str,
    thread,
    time::Duration,
    vec::Vec,
};
use tempfile::NamedTempFile;

const NETWORK_NAME: &str = "oz-local";
const NETWORK_PASSPHRASE: &str = "Standalone Network ; February 2017";
const RPC_URL: &str = "http://127.0.0.1:8000/soroban/rpc";
const TESTNET_NAME: &str = "testnet";
const TESTNET_RPC_URL: &str = "https://soroban-testnet.stellar.org";
const TESTNET_NETWORK_PASSPHRASE: &str = "Test SDF Network ; September 2015";
const CONTAINER_NAME: &str = "oz-confidential-local";
const AUDITOR_ID: u32 = 1;
const LIVE_UNTIL_LEDGER_OFFSET: u32 = 10_000;
const POSEIDON2_IV_BASE: u128 = 1u128 << 64;
const SBOX_D: u32 = 5;

const DOMAIN_VIEWING_KEY: u32 = 2;
const DOMAIN_DELEGATION_VIEWING_KEY: u32 = 3;
const DOMAIN_SPEND_RANDOMNESS: u32 = 4;
const DOMAIN_TX_BLINDING: u32 = 5;
const DOMAIN_TX_AMOUNT: u32 = 6;
const DOMAIN_ENCRYPTED_BALANCE: u32 = 7;
const DOMAIN_ENCRYPTED_ALLOWANCE: u32 = 8;
const DOMAIN_ALLOWANCE_RANDOMNESS: u32 = 9;
const DOMAIN_ESCROWED_DVK: u32 = 10;
const DOMAIN_AUDITOR_SENDER: u32 = 11;
const DOMAIN_AUDITOR_RECIPIENT: u32 = 12;

const BN254_FR_MODULUS_HEX: &str =
    "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";
const H_HEX: &str =
    "054aa86a73cb8a34525e5bbed6e43ba1198e860f5f3950268f71df4591bde402209dcfbf2cfb57f9f6046f44d71ac6faf87254afc7407c04eb621a6287cac126";

#[derive(Clone)]
struct ParticipantConfig {
    name: &'static str,
    sk: u128,
}

#[derive(Clone)]
struct OperationScalars {
    r_e: u128,
    sigma: u128,
    sigma_alt: Option<u128>,
}

#[derive(Clone, Serialize)]
struct DeploymentSet {
    policy: String,
    auditor_registry: String,
    verifier_registry: String,
    tusdc: String,
    ttbill: String,
    txaum: String,
    cusdc: String,
    ctbill: String,
    cxaum: String,
}

#[derive(Clone, Serialize)]
struct Phase3DeploymentSet {
    participant_policy: String,
    collateral_policy_registry: String,
    oracle_adapter: String,
    collateral_lock_registry: String,
    collateral_sufficiency_verifier: Option<String>,
    prefunding_credit_line: String,
    mock_ctbill: String,
}

#[derive(Serialize)]
struct Phase3Report {
    network: String,
    accounts: BTreeMap<String, String>,
    contracts: Phase3DeploymentSet,
    approved_proof_hash: String,
    tests: BTreeMap<String, Value>,
}

#[derive(Clone, Serialize)]
struct Phase4DeploymentSet {
    participant_policy: String,
    collateral_policy_registry: String,
    oracle_adapter: String,
    collateral_lock_registry: String,
    collateral_sufficiency_verifier: String,
    prefunding_credit_line: String,
    mock_ctbill: String,
}

#[derive(Clone, Serialize)]
struct Phase6DeploymentSet {
    repayment_history_verifier: String,
    repayment_history_registry: String,
    disclosure_grant_registry: String,
}

#[derive(Clone)]
struct CollateralProofArtifacts {
    collateral_commitment: Point,
    credit_commitment: Point,
    lock_key: BigUint,
    position_nullifier: BigUint,
    oracle_price_e7: u128,
    haircut_bps: u32,
    tenor_days: u32,
    public_inputs: Vec<u8>,
    proof: Vec<u8>,
}

#[derive(Serialize)]
struct Phase4Report {
    network: String,
    accounts: BTreeMap<String, String>,
    contracts: Phase4DeploymentSet,
    proof: BTreeMap<String, Value>,
    tests: BTreeMap<String, Value>,
}

#[derive(Clone)]
struct TokenContext {
    name: &'static str,
    symbol: &'static str,
    public_token: String,
    confidential_token: String,
    addr_f: BigUint,
}

#[derive(Clone)]
struct Actor {
    name: &'static str,
    stellar_address: String,
    sk: BigUint,
    y: Point,
    per_token: BTreeMap<String, AccountState>,
}

#[derive(Clone)]
struct AccountState {
    vk: BigUint,
    pvk: Point,
    spendable_value: u128,
    spendable_r: BigUint,
    spendable_balance: Point,
    receiving_value: u128,
    receiving_r: BigUint,
    receiving_balance: Point,
    delegations: BTreeMap<String, DelegationState>,
}

#[derive(Clone)]
struct DelegationState {
    dvk: BigUint,
    value: u128,
    randomness: BigUint,
    commitment: Point,
    sigma_a: BigUint,
    escrowed_dvk: Point,
    live_until_ledger: u32,
}

#[derive(Serialize)]
struct ProofOfLifeReport {
    accounts: BTreeMap<String, String>,
    contracts: DeploymentSet,
    c_usdc_state_views: BTreeMap<String, String>,
    delegation_view: String,
    tests: BTreeMap<String, Value>,
}

struct Runner {
    root: PathBuf,
    config_dir: PathBuf,
    wasm_dir: PathBuf,
    state_dir: PathBuf,
    circuits_dir: PathBuf,
    env: Env,
}

impl Runner {
    fn new() -> Result<Self> {
        let root = env::current_dir().context("expected to run from oz-confidential root")?;
        let state_dir = root.join("state");
        let wasm_dir = state_dir.join("wasm");
        let config_dir = state_dir.join("stellar-config");
        let circuits_dir = root.join("circuits");
        fs::create_dir_all(&state_dir)?;
        fs::create_dir_all(&wasm_dir)?;
        fs::create_dir_all(&config_dir)?;
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        Ok(Self { root, config_dir, wasm_dir, state_dir, circuits_dir, env })
    }

    fn run(&self) -> Result<()> {
        eprintln!("==> checking toolchain");
        self.ensure_binaries()?;
        eprintln!("==> resetting localnet");
        self.reset_localnet()?;
        eprintln!("==> ensuring network profile");
        self.ensure_network_profile()?;

        let account_configs = [
            ParticipantConfig { name: "admin", sk: 7 },
            ParticipantConfig { name: "alpha", sk: 11 },
            ParticipantConfig { name: "facility", sk: 22 },
            ParticipantConfig { name: "auditor", sk: 33 },
            ParticipantConfig { name: "credit-executor", sk: 44 },
        ];
        eprintln!("==> ensuring identities");
        let account_addrs = self.ensure_accounts(&account_configs)?;

        eprintln!("==> building contract WASMs");
        self.build_wasms()?;
        eprintln!("==> deploying contracts");
        let deployments = self.deploy_contracts(&account_addrs)?;
        eprintln!("==> registering auditor key");
        self.register_auditor_key(&deployments.auditor_registry, &account_addrs["admin"])?;
        eprintln!("==> registering verification keys");
        self.register_verification_keys(&deployments.verifier_registry, &account_addrs["admin"])?;

        eprintln!("==> initializing actors");
        let mut actors = self.initialize_actors(&account_configs, &account_addrs)?;
        let token_contexts = self.token_contexts(&deployments);
        eprintln!("==> registering confidential accounts");
        self.register_accounts(&mut actors, &token_contexts, &account_addrs)?;
        eprintln!("==> seeding public balances");
        self.seed_public_balances(&deployments, &account_addrs)?;

        let op_transfer = OperationScalars { r_e: 101, sigma: 201, sigma_alt: None };
        let op_set_spender = OperationScalars { r_e: 102, sigma: 202, sigma_alt: Some(302) };
        let op_spender_transfer =
            OperationScalars { r_e: 103, sigma: 0, sigma_alt: Some(402) };
        let op_revoke = OperationScalars { r_e: 104, sigma: 204, sigma_alt: None };
        let blocked_transfer = OperationScalars { r_e: 105, sigma: 205, sigma_alt: None };
        let blocked_send = OperationScalars { r_e: 106, sigma: 206, sigma_alt: None };

        let c_usdc = token_contexts
            .iter()
            .find(|ctx| ctx.name == "cUSDC")
            .cloned()
            .ok_or_else(|| anyhow!("missing cUSDC token context"))?;

        eprintln!("==> deposit alpha -> cUSDC");
        self.deposit(&deployments.cusdc, "alpha", &account_addrs["alpha"], 1_000)?;
        {
            let alpha = actors.get_mut("alpha").unwrap();
            alpha.account_mut(&c_usdc).apply_deposit(&self.env, 1_000);
        }

        eprintln!("==> merge alpha cUSDC");
        self.merge(&deployments.cusdc, "alpha")?;
        {
            let alpha = actors.get_mut("alpha").unwrap();
            alpha.account_mut(&c_usdc).merge(&self.env);
        }

        let mut facility = actors
            .remove("facility")
            .ok_or_else(|| anyhow!("missing facility actor"))?;
        eprintln!("==> confidential transfer alpha -> facility");
        let transfer_result = self.confidential_transfer(
            &c_usdc,
            actors.get_mut("alpha").unwrap(),
            &mut facility,
            200,
            &account_addrs["alpha"],
            &op_transfer,
        )?;

        let credit_executor = actors
            .get("credit-executor")
            .cloned()
            .ok_or_else(|| anyhow!("missing credit-executor actor"))?;
        eprintln!("==> set spender alpha -> credit-executor");
        self.set_spender(
            &c_usdc,
            actors.get_mut("alpha").unwrap(),
            &credit_executor,
            150,
            self.current_ledger()?.saturating_add(LIVE_UNTIL_LEDGER_OFFSET),
            &account_addrs["alpha"],
            &op_set_spender,
        )?;
        let delegation_view = self.view_spender_delegation(
            &deployments.cusdc,
            &account_addrs["alpha"],
            &account_addrs["credit-executor"],
        )?;

        eprintln!("==> spender transfer credit-executor: alpha -> facility");
        self.confidential_transfer_from(
            &c_usdc,
            actors.get_mut("alpha").unwrap(),
            &credit_executor,
            &mut facility,
            50,
            &account_addrs["credit-executor"],
            &op_spender_transfer,
        )?;

        eprintln!("==> revoke spender alpha -> credit-executor");
        self.revoke_spender(
            &c_usdc,
            actors.get_mut("alpha").unwrap(),
            &credit_executor,
            &account_addrs["alpha"],
            &op_revoke,
        )?;

        eprintln!("==> merge facility cUSDC");
        self.merge(&deployments.cusdc, "facility")?;
        facility.account_mut(&c_usdc).merge(&self.env);

        actors.insert("facility".to_string(), facility.clone());

        eprintln!("==> block facility in policy");
        self.set_policy_blocked(
            &deployments.policy,
            &account_addrs["facility"],
            true,
            &account_addrs["admin"],
        )?;

        eprintln!("==> attempt blocked receive");
        let receive_blocked = self.try_confidential_transfer(
            &c_usdc,
            actors.get("alpha").unwrap(),
            &facility,
            1,
            &account_addrs["alpha"],
            &blocked_transfer,
        )?;
        eprintln!("==> attempt blocked send");
        let send_blocked = self.try_confidential_transfer(
            &c_usdc,
            &facility,
            actors.get("alpha").unwrap(),
            10,
            &account_addrs["facility"],
            &blocked_send,
        )?;

        eprintln!("==> collect state views and events");
        let confidential_balance_alpha =
            self.view_confidential_balance(&deployments.cusdc, &account_addrs["alpha"])?;
        let confidential_balance_facility =
            self.view_confidential_balance(&deployments.cusdc, &account_addrs["facility"])?;

        let events_raw = self.fetch_contract_events(&deployments.cusdc).unwrap_or_else(|err| {
            json!({
                "warning": format!("event fetch failed: {err:#}"),
            })
        });

        let report = ProofOfLifeReport {
            accounts: account_addrs.clone(),
            contracts: deployments.clone(),
            c_usdc_state_views: BTreeMap::from([
                ("alpha".to_string(), confidential_balance_alpha.clone()),
                ("facility".to_string(), confidential_balance_facility.clone()),
            ]),
            delegation_view: delegation_view.clone(),
            tests: BTreeMap::from([
                (
                    "transfer_amount_hidden_in_public_state".to_string(),
                    json!({
                        "public_confidential_balance_alpha": confidential_balance_alpha,
                        "public_confidential_balance_facility": confidential_balance_facility,
                        "plain_amount_visible_as_decimal": confidential_balance_alpha.contains("200")
                            || confidential_balance_facility.contains("200"),
                    }),
                ),
                (
                    "auditor_ciphertext_emitted".to_string(),
                    json!({
                        "transfer_payload": transfer_result.event_snapshot(),
                        "events": events_raw,
                    }),
                ),
                (
                    "auditor_decrypt_matches_amount".to_string(),
                    transfer_result.decrypt_report(&self.env, &account_addrs["auditor"]),
                ),
                (
                    "policy_blocks_receive_and_send".to_string(),
                    json!({
                        "receive_error": receive_blocked,
                        "send_error": send_blocked,
                    }),
                ),
                (
                    "set_spender_creates_allowance_commitment".to_string(),
                    json!({
                        "delegation_view": delegation_view,
                    }),
                ),
            ]),
        };

        eprintln!("==> writing proof-of-life report");
        let report_path = self.state_dir.join("proof-of-life-report.json");
        fs::write(&report_path, serde_json::to_vec_pretty(&report)?)?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        eprintln!("report written to {}", report_path.display());
        Ok(())
    }

    fn run_phase3(&self, network: &str, reset_localnet: bool) -> Result<()> {
        eprintln!("==> checking toolchain");
        self.ensure_phase3_binaries()?;
        if reset_localnet {
            eprintln!("==> resetting localnet");
            self.reset_localnet()?;
            eprintln!("==> ensuring local network profile");
            self.ensure_network_profile()?;
        } else {
            eprintln!("==> ensuring testnet profile");
            self.ensure_testnet_profile()?;
        }

        let account_configs = [
            ParticipantConfig { name: "admin", sk: 7 },
            ParticipantConfig { name: "alpha", sk: 11 },
            ParticipantConfig { name: "rejected", sk: 55 },
        ];
        eprintln!("==> ensuring phase3 identities on {network}");
        let account_addrs = self.ensure_accounts_on(&account_configs, network)?;

        eprintln!("==> building phase3 contract WASMs");
        self.build_phase3_wasms()?;
        eprintln!("==> deploying phase3 contracts");
        let deployments = self.deploy_phase3_contracts(network, &account_addrs)?;

        let approved_proof_hash =
            "1111111111111111111111111111111111111111111111111111111111111111";
        let unapproved_proof_hash =
            "9999999999999999999999999999999999999999999999999999999999999999";
        let lock_key = "2222222222222222222222222222222222222222222222222222222222222222";
        let reused_position_id =
            "3333333333333333333333333333333333333333333333333333333333333333";
        let position_id =
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let rejected_position_id =
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let tenor_fail_position_id =
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        let stale_fail_position_id =
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        let rejected_lock_key =
            "4444444444444444444444444444444444444444444444444444444444444444";
        let tenor_lock_key =
            "5555555555555555555555555555555555555555555555555555555555555555";
        let stale_lock_key =
            "6666666666666666666666666666666666666666666666666666666666666666";

        eprintln!("==> seeding participant policy from business decision");
        self.set_participant(
            network,
            &deployments.participant_policy,
            &account_addrs["alpha"],
            true,
            &account_addrs["admin"],
        )?;
        self.set_participant(
            network,
            &deployments.participant_policy,
            &account_addrs["rejected"],
            false,
            &account_addrs["admin"],
        )?;

        let latest_ledger = self.current_ledger_on(network)?;
        eprintln!("==> seeding oracle and collateral policy at ledger {latest_ledger}");
        self.set_oracle_price(
            network,
            &deployments.oracle_adapter,
            &deployments.mock_ctbill,
            10_000_000,
            latest_ledger,
            &account_addrs["admin"],
        )?;
        self.set_collateral_policy(
            network,
            &deployments.collateral_policy_registry,
            &deployments.mock_ctbill,
            true,
            500,
            5,
            &deployments.oracle_adapter,
            1_000,
            &account_addrs["admin"],
        )?;
        self.set_approved_proof(
            network,
            &deployments.prefunding_credit_line,
            approved_proof_hash,
            true,
            &account_addrs["admin"],
        )?;

        eprintln!("==> opening alpha credit line with mock cTBill collateral");
        let open_alpha = self.open_credit(
            network,
            &deployments.prefunding_credit_line,
            position_id,
            &account_addrs["alpha"],
            &deployments.mock_ctbill,
            lock_key,
            1_000,
            2_000,
            3,
            approved_proof_hash,
            &account_addrs["admin"],
            true,
        )?;

        eprintln!("==> checking failure cases while collateral is locked");
        let rejected_wallet = self.open_credit(
            network,
            &deployments.prefunding_credit_line,
            rejected_position_id,
            &account_addrs["rejected"],
            &deployments.mock_ctbill,
            rejected_lock_key,
            1_000,
            2_000,
            3,
            approved_proof_hash,
            &account_addrs["admin"],
            false,
        )?;
        let reused_lock = self.open_credit(
            network,
            &deployments.prefunding_credit_line,
            reused_position_id,
            &account_addrs["alpha"],
            &deployments.mock_ctbill,
            lock_key,
            1_000,
            2_000,
            3,
            approved_proof_hash,
            &account_addrs["admin"],
            false,
        )?;
        let revoke_locked = self.assert_revoke_allowed(
            network,
            &deployments.collateral_lock_registry,
            lock_key,
            false,
        )?;
        let unapproved_proof = self.open_credit(
            network,
            &deployments.prefunding_credit_line,
            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            &account_addrs["alpha"],
            &deployments.mock_ctbill,
            "7777777777777777777777777777777777777777777777777777777777777777",
            1_000,
            2_000,
            3,
            unapproved_proof_hash,
            &account_addrs["admin"],
            false,
        )?;

        eprintln!("==> repaying and confirming lock release");
        self.repay_credit(
            network,
            &deployments.prefunding_credit_line,
            position_id,
            &account_addrs["admin"],
        )?;
        let revoke_after_repay = self.assert_revoke_allowed(
            network,
            &deployments.collateral_lock_registry,
            lock_key,
            true,
        )?;

        eprintln!("==> checking tenor and stale oracle failures");
        let tenor_above_five = self.open_credit(
            network,
            &deployments.prefunding_credit_line,
            tenor_fail_position_id,
            &account_addrs["alpha"],
            &deployments.mock_ctbill,
            tenor_lock_key,
            1_000,
            2_000,
            6,
            approved_proof_hash,
            &account_addrs["admin"],
            false,
        )?;
        self.set_oracle_price(
            network,
            &deployments.oracle_adapter,
            &deployments.mock_ctbill,
            10_000_000,
            latest_ledger.saturating_sub(2_000),
            &account_addrs["admin"],
        )?;
        let stale_oracle = self.open_credit(
            network,
            &deployments.prefunding_credit_line,
            stale_fail_position_id,
            &account_addrs["alpha"],
            &deployments.mock_ctbill,
            stale_lock_key,
            1_000,
            2_000,
            3,
            approved_proof_hash,
            &account_addrs["admin"],
            false,
        )?;

        let report = Phase3Report {
            network: network.to_string(),
            accounts: account_addrs,
            contracts: deployments,
            approved_proof_hash: approved_proof_hash.to_string(),
            tests: BTreeMap::from([
                (
                    "anchor_accepted_gets_policy_approval".to_string(),
                    json!({ "alpha_open_result": open_alpha }),
                ),
                ("rejected_wallet_fails_to_open_credit".to_string(), json!({ "error": rejected_wallet })),
                ("same_collateral_lock_cannot_be_reused".to_string(), json!({ "error": reused_lock })),
                ("locked_collateral_revoke_fails".to_string(), json!({ "error": revoke_locked })),
                ("mock_proof_requires_approved_hash".to_string(), json!({ "error": unapproved_proof })),
                (
                    "repayment_releases_collateral_lock".to_string(),
                    json!({ "assert_revoke_after_repay": revoke_after_repay }),
                ),
                ("tenor_above_5_days_fails".to_string(), json!({ "error": tenor_above_five })),
                ("stale_oracle_price_fails".to_string(), json!({ "error": stale_oracle })),
            ]),
        };

        let report_path = self
            .state_dir
            .join(format!("phase3-{}-report.json", network.replace('-', "_")));
        fs::write(&report_path, serde_json::to_vec_pretty(&report)?)?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        eprintln!("phase3 report written to {}", report_path.display());
        Ok(())
    }

    fn run_phase4(&self, network: &str, reset_localnet: bool) -> Result<()> {
        eprintln!("==> checking phase4 toolchain");
        self.ensure_binaries()?;
        if reset_localnet {
            eprintln!("==> resetting localnet");
            self.reset_localnet()?;
            eprintln!("==> ensuring local network profile");
            self.ensure_network_profile()?;
        } else {
            eprintln!("==> ensuring testnet profile");
            self.ensure_testnet_profile()?;
        }

        let account_configs = [
            ParticipantConfig { name: "admin", sk: 7 },
            ParticipantConfig { name: "alpha", sk: 11 },
            ParticipantConfig { name: "rejected", sk: 55 },
        ];
        eprintln!("==> ensuring phase4 identities on {network}");
        let account_addrs = self.ensure_accounts_on(&account_configs, network)?;

        let proof_dir = self.state_dir.join("proof-collateral-sufficiency");
        eprintln!("==> generating collateral sufficiency VK and valid proof");
        let valid_proof = self.run_collateral_sufficiency_proof(
            2_000,
            &BigUint::from(101u32),
            1_000,
            &BigUint::from(202u32),
            &BigUint::from(303u32),
            &BigUint::parse_bytes(
                b"2222222222222222222222222222222222222222222222222222222222222222",
                16,
            )
            .unwrap(),
            10_000_000,
            500,
            3,
            &proof_dir,
        )?;

        eprintln!("==> building phase4 contract WASMs");
        self.build_phase3_wasms()?;
        eprintln!("==> deploying phase4 contracts");
        let deployments = self.deploy_phase4_contracts(network, &account_addrs, &proof_dir.join("vk"))?;

        eprintln!("==> seeding participant policy and collateral policy");
        self.set_participant(
            network,
            &deployments.participant_policy,
            &account_addrs["alpha"],
            true,
            &account_addrs["admin"],
        )?;
        self.set_participant(
            network,
            &deployments.participant_policy,
            &account_addrs["rejected"],
            false,
            &account_addrs["admin"],
        )?;
        let latest_ledger = self.current_ledger_on(network)?;
        self.set_oracle_price(
            network,
            &deployments.oracle_adapter,
            &deployments.mock_ctbill,
            10_000_000,
            latest_ledger,
            &account_addrs["admin"],
        )?;
        self.set_collateral_policy(
            network,
            &deployments.collateral_policy_registry,
            &deployments.mock_ctbill,
            true,
            500,
            5,
            &deployments.oracle_adapter,
            1_000,
            &account_addrs["admin"],
        )?;

        eprintln!("==> opening alpha credit line with real UltraHonk proof");
        let valid_open = self.open_credit_with_proof(
            network,
            &deployments.prefunding_credit_line,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            &account_addrs["alpha"],
            &deployments.mock_ctbill,
            &valid_proof,
            &valid_proof.public_inputs,
            &valid_proof.proof,
            &account_addrs["admin"],
            true,
        )?;

        eprintln!("==> checking proof and policy failure cases");
        let replay_same_nullifier = self.open_credit_with_proof(
            network,
            &deployments.prefunding_credit_line,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            &account_addrs["alpha"],
            &deployments.mock_ctbill,
            &valid_proof,
            &valid_proof.public_inputs,
            &valid_proof.proof,
            &account_addrs["admin"],
            false,
        )?;

        let negative_base_proof = self.run_collateral_sufficiency_proof(
            2_000,
            &BigUint::from(111u32),
            1_000,
            &BigUint::from(222u32),
            &BigUint::from(606u32),
            &BigUint::parse_bytes(
                b"2323232323232323232323232323232323232323232323232323232323232323",
                16,
            )
            .unwrap(),
            10_000_000,
            500,
            3,
            &self.state_dir.join("proof-collateral-sufficiency-negative-base"),
        )?;

        let mut tampered_proof_bytes = negative_base_proof.proof.clone();
        if let Some(first) = tampered_proof_bytes.first_mut() {
            *first ^= 1;
        }
        let tampered_proof = self.open_credit_with_proof(
            network,
            &deployments.prefunding_credit_line,
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            &account_addrs["alpha"],
            &deployments.mock_ctbill,
            &negative_base_proof,
            &negative_base_proof.public_inputs,
            &tampered_proof_bytes,
            &account_addrs["admin"],
            false,
        )?;

        let mut wrong_price_artifacts = negative_base_proof.clone();
        wrong_price_artifacts.oracle_price_e7 = 9_000_000;
        let wrong_price_inputs =
            replace_public_input_u128(&negative_base_proof.public_inputs, 4, wrong_price_artifacts.oracle_price_e7);
        let wrong_public_oracle_price = self.open_credit_with_proof(
            network,
            &deployments.prefunding_credit_line,
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            &account_addrs["alpha"],
            &deployments.mock_ctbill,
            &wrong_price_artifacts,
            &wrong_price_inputs,
            &negative_base_proof.proof,
            &account_addrs["admin"],
            false,
        )?;

        let mut wrong_haircut_artifacts = negative_base_proof.clone();
        wrong_haircut_artifacts.haircut_bps = 600;
        let wrong_haircut_inputs =
            replace_public_input_u128(&negative_base_proof.public_inputs, 5, wrong_haircut_artifacts.haircut_bps as u128);
        let wrong_public_haircut = self.open_credit_with_proof(
            network,
            &deployments.prefunding_credit_line,
            "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            &account_addrs["alpha"],
            &deployments.mock_ctbill,
            &wrong_haircut_artifacts,
            &wrong_haircut_inputs,
            &negative_base_proof.proof,
            &account_addrs["admin"],
            false,
        )?;

        let same_lock_different_tenor_proof = self.run_collateral_sufficiency_proof(
            2_000,
            &BigUint::from(101u32),
            1_000,
            &BigUint::from(202u32),
            &BigUint::from(404u32),
            &valid_proof.lock_key,
            10_000_000,
            500,
            4,
            &self.state_dir.join("proof-collateral-sufficiency-tenor4"),
        )?;
        let same_lock_different_tenor = self.open_credit_with_proof(
            network,
            &deployments.prefunding_credit_line,
            "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            &account_addrs["alpha"],
            &deployments.mock_ctbill,
            &same_lock_different_tenor_proof,
            &same_lock_different_tenor_proof.public_inputs,
            &same_lock_different_tenor_proof.proof,
            &account_addrs["admin"],
            false,
        )?;

        let over_borrow_proof_generation = self
            .run_collateral_sufficiency_proof(
                2_000,
                &BigUint::from(101u32),
                3_000,
                &BigUint::from(202u32),
                &BigUint::from(505u32),
                &BigUint::parse_bytes(
                    b"1111111111111111111111111111111111111111111111111111111111111111",
                    16,
                )
                .unwrap(),
                10_000_000,
                500,
                3,
                &self.state_dir.join("proof-collateral-sufficiency-overborrow"),
            )
            .err()
            .map(|err| format!("{err:#}"))
            .unwrap_or_else(|| "unexpectedly generated over-borrow proof".to_string());

        let wrong_randomness_generation = self
            .run_wrong_randomness_collateral_proof(&valid_proof)
            .err()
            .map(|err| format!("{err:#}"))
            .unwrap_or_else(|| "unexpectedly generated wrong-randomness proof".to_string());

        let report = Phase4Report {
            network: network.to_string(),
            accounts: account_addrs,
            contracts: deployments,
            proof: BTreeMap::from([
                ("verified_public_view".to_string(), json!({
                    "proof_verified": true,
                    "collateral_amount_hidden": true,
                    "borrow_amount_hidden": true,
                    "collateral_commitment_x": field_to_hex(&point_x(&self.env, &valid_proof.collateral_commitment)),
                    "collateral_commitment_y": field_to_hex(&point_y(&self.env, &valid_proof.collateral_commitment)),
                    "credit_commitment_x": field_to_hex(&point_x(&self.env, &valid_proof.credit_commitment)),
                    "credit_commitment_y": field_to_hex(&point_y(&self.env, &valid_proof.credit_commitment)),
                    "position_nullifier": field_to_hex(&valid_proof.position_nullifier),
                })),
            ]),
            tests: BTreeMap::from([
                ("valid_collateral_proof_opens_credit".to_string(), json!({ "result": valid_open })),
                ("over_borrow_case_fails".to_string(), json!({ "proof_generation_error": over_borrow_proof_generation })),
                ("wrong_commitment_randomness_fails".to_string(), json!({ "proof_generation_error": wrong_randomness_generation })),
                ("wrong_public_oracle_price_fails".to_string(), json!({ "error": wrong_public_oracle_price })),
                ("wrong_public_haircut_fails".to_string(), json!({ "error": wrong_public_haircut })),
                ("tampered_proof_fails".to_string(), json!({ "error": tampered_proof })),
                ("replay_same_position_nullifier_fails".to_string(), json!({ "error": replay_same_nullifier })),
                ("same_allowance_different_tenor_lock_blocks".to_string(), json!({ "error": same_lock_different_tenor })),
            ]),
        };

        let report_path = self
            .state_dir
            .join(format!("phase4-{}-report.json", network.replace('-', "_")));
        fs::write(&report_path, serde_json::to_vec_pretty(&report)?)?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        eprintln!("phase4 report written to {}", report_path.display());
        Ok(())
    }

    fn print_collateral_fixture(&self, lock_key_hex: &str, position_secret_dec: &str) -> Result<()> {
        let collateral_amount = 2_000u128;
        let collateral_randomness = BigUint::from(111u32);
        let credit_amount = 1_000u128;
        let credit_randomness = BigUint::from(222u32);
        let oracle_price_e7 = 10_000_000u128;
        let haircut_bps = 500u32;
        let tenor_days = 3u32;
        let lock_key = BigUint::parse_bytes(lock_key_hex.trim_start_matches("0x").as_bytes(), 16)
            .ok_or_else(|| anyhow!("invalid lock key hex"))?;
        let position_secret = BigUint::parse_bytes(position_secret_dec.as_bytes(), 10)
            .ok_or_else(|| anyhow!("invalid position secret decimal"))?;

        let collateral_commitment =
            commit(&self.env, collateral_amount, &collateral_randomness);
        let credit_commitment = commit(&self.env, credit_amount, &credit_randomness);
        let collateral_commitment_x = point_x(&self.env, &collateral_commitment);
        let collateral_commitment_y = point_y(&self.env, &collateral_commitment);
        let credit_commitment_x = point_x(&self.env, &credit_commitment);
        let credit_commitment_y = point_y(&self.env, &credit_commitment);
        let position_nullifier = poseidon_with_domain_any(
            &self.env,
            30,
            &[
                position_secret.clone(),
                collateral_commitment_x.clone(),
                collateral_commitment_y.clone(),
                credit_commitment_x.clone(),
                credit_commitment_y.clone(),
                lock_key.clone(),
                BigUint::from(tenor_days),
            ],
        );

        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "collateralAmount": collateral_amount.to_string(),
                "collateralRandomness": collateral_randomness.to_str_radix(10),
                "creditAmount": credit_amount.to_string(),
                "creditRandomness": credit_randomness.to_str_radix(10),
                "positionSecret": position_secret.to_str_radix(10),
                "collateralCommitmentX": collateral_commitment_x.to_str_radix(10),
                "collateralCommitmentY": collateral_commitment_y.to_str_radix(10),
                "creditCommitmentX": credit_commitment_x.to_str_radix(10),
                "creditCommitmentY": credit_commitment_y.to_str_radix(10),
                "oraclePriceE7": oracle_price_e7.to_string(),
                "haircutBps": haircut_bps,
                "tenorDays": tenor_days,
                "lockKey": lock_key.to_str_radix(10),
                "positionNullifier": position_nullifier.to_str_radix(10),
                "hex": {
                    "collateralCommitmentX": field_to_hex(&collateral_commitment_x),
                    "collateralCommitmentY": field_to_hex(&collateral_commitment_y),
                    "creditCommitmentX": field_to_hex(&credit_commitment_x),
                    "creditCommitmentY": field_to_hex(&credit_commitment_y),
                    "oraclePriceE7": field_to_hex(&BigUint::from(oracle_price_e7)),
                    "haircutBps": field_to_hex(&BigUint::from(haircut_bps)),
                    "tenorDays": field_to_hex(&BigUint::from(tenor_days)),
                    "lockKey": field_to_hex(&lock_key),
                    "positionNullifier": field_to_hex(&position_nullifier)
                }
            }))?
        );
        Ok(())
    }

    fn print_repayment_history_fixture(
        &self,
        position_id_hex: &str,
        proof_secret_dec: &str,
    ) -> Result<()> {
        let position_id = BigUint::parse_bytes(position_id_hex.trim_start_matches("0x").as_bytes(), 16)
            .ok_or_else(|| anyhow!("invalid position id hex"))?;
        let proof_secret = BigUint::parse_bytes(proof_secret_dec.as_bytes(), 10)
            .ok_or_else(|| anyhow!("invalid proof secret decimal"))?;
        let threshold = 2u32;
        let leaves = [
            (300u128, 100u32, 120u32, BigUint::from(911u32)),
            (350u128, 110u32, 120u32, BigUint::from(922u32)),
            (400u128, 140u32, 120u32, BigUint::from(933u32)),
        ];

        let mut leaf_values = Vec::new();
        for (amount, paid_ledger, due_ledger, secret) in &leaves {
            leaf_values.push(poseidon_with_domain_any(
                &self.env,
                40,
                &[
                    position_id.clone(),
                    BigUint::from(*amount),
                    BigUint::from(*paid_ledger),
                    BigUint::from(*due_ledger),
                    secret.clone(),
                ],
            ));
        }
        let history_root = poseidon_with_domain_any(
            &self.env,
            41,
            &[
                position_id.clone(),
                leaf_values[0].clone(),
                leaf_values[1].clone(),
                leaf_values[2].clone(),
            ],
        );
        let proof_nullifier = poseidon_with_domain_any(
            &self.env,
            42,
            &[
                position_id.clone(),
                history_root.clone(),
                BigUint::from(threshold),
                proof_secret.clone(),
            ],
        );
        let public_inputs_hex = [
            field_to_hex(&position_id),
            field_to_hex(&history_root),
            field_to_hex(&BigUint::from(threshold)),
            field_to_hex(&proof_nullifier),
        ]
        .join("");

        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "positionId": position_id.to_str_radix(10),
                "proofSecret": proof_secret.to_str_radix(10),
                "threshold": threshold,
                "historyRoot": history_root.to_str_radix(10),
                "proofNullifier": proof_nullifier.to_str_radix(10),
                "publicInputsHex": public_inputs_hex,
                "leaves": [
                    {
                        "repaymentAmount": leaves[0].0.to_string(),
                        "paidLedger": leaves[0].1,
                        "dueLedger": leaves[0].2,
                        "leafSecret": leaves[0].3.to_str_radix(10),
                        "leafNullifier": field_to_hex(&leaf_values[0]),
                        "repaymentCommitment": field_to_hex(&leaf_values[0]),
                        "onTime": leaves[0].1 <= leaves[0].2
                    },
                    {
                        "repaymentAmount": leaves[1].0.to_string(),
                        "paidLedger": leaves[1].1,
                        "dueLedger": leaves[1].2,
                        "leafSecret": leaves[1].3.to_str_radix(10),
                        "leafNullifier": field_to_hex(&leaf_values[1]),
                        "repaymentCommitment": field_to_hex(&leaf_values[1]),
                        "onTime": leaves[1].1 <= leaves[1].2
                    },
                    {
                        "repaymentAmount": leaves[2].0.to_string(),
                        "paidLedger": leaves[2].1,
                        "dueLedger": leaves[2].2,
                        "leafSecret": leaves[2].3.to_str_radix(10),
                        "leafNullifier": field_to_hex(&leaf_values[2]),
                        "repaymentCommitment": field_to_hex(&leaf_values[2]),
                        "onTime": leaves[2].1 <= leaves[2].2
                    }
                ],
                "hex": {
                    "positionId": field_to_hex(&position_id),
                    "historyRoot": field_to_hex(&history_root),
                    "threshold": field_to_hex(&BigUint::from(threshold)),
                    "proofNullifier": field_to_hex(&proof_nullifier)
                }
            }))?
        );
        Ok(())
    }

    fn run_phase6_deploy(&self, network: &str) -> Result<()> {
        eprintln!("==> generating repayment history VK");
        let proof_dir = self.state_dir.join("proof-repayment-history");
        self.generate_vk("circuit_repayment_history", &proof_dir)?;

        eprintln!("==> building phase6 contract WASMs");
        self.build_phase6_wasms()?;

        eprintln!("==> deploying phase6 contracts on {network}");
        let admin = self
            .run_stellar(["keys", "public-key", "admin"], true)?
            .trim()
            .to_string();
        self.run_stellar(["keys", "fund", "admin", "-n", network], true)?;
        let deployments = self.deploy_phase6_contracts(network, &admin, &proof_dir.join("vk"))?;
        let report = json!({
            "network": network,
            "admin": admin,
            "contracts": deployments,
        });
        let report_path = self
            .state_dir
            .join(format!("phase6-{}-deployments.json", network.replace('-', "_")));
        fs::write(&report_path, serde_json::to_string_pretty(&report)?)?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        eprintln!("phase6 deployments written to {}", report_path.display());
        Ok(())
    }

    fn ensure_binaries(&self) -> Result<()> {
        for bin in ["stellar", "cargo", "nargo", "bb", "curl", "jq"] {
            self.run_command("bash", ["-lc", &format!("command -v {bin}")], Some(&self.root))
                .with_context(|| format!("missing required binary `{bin}`"))?;
        }
        Ok(())
    }

    fn ensure_phase3_binaries(&self) -> Result<()> {
        for bin in ["stellar", "cargo"] {
            self.run_command("bash", ["-lc", &format!("command -v {bin}")], Some(&self.root))
                .with_context(|| format!("missing required binary `{bin}`"))?;
        }
        Ok(())
    }

    fn reset_localnet(&self) -> Result<()> {
        let _ = self.run_command("docker", ["rm", "-f", CONTAINER_NAME], Some(&self.root));
        let _ = self.run_command(
            "docker",
            ["rm", "-f", &format!("stellar-{CONTAINER_NAME}")],
            Some(&self.root),
        );
        let _ = self.run_stellar(["container", "stop", CONTAINER_NAME], false);
        let _ =
            self.run_stellar(["network", "rm", NETWORK_NAME], false).map_err(|_| ());
        self.run_stellar(
            [
                "container",
                "start",
                "local",
                "--name",
                CONTAINER_NAME,
                "-p",
                "8000:8000",
            ],
            true,
        )?;
        self.wait_for_localnet()
    }

    fn wait_for_localnet(&self) -> Result<()> {
        for _ in 0..30 {
            if self
                .run_stellar(["network", "health", "-n", NETWORK_NAME], false)
                .is_ok()
            {
                return Ok(());
            }
            thread::sleep(Duration::from_secs(1));
        }
        bail!("localnet did not become healthy in time")
    }

    fn ensure_network_profile(&self) -> Result<()> {
        let _ = self.run_stellar(["network", "rm", NETWORK_NAME], false);
        self.run_stellar(
            [
                "network",
                "add",
                NETWORK_NAME,
                "--rpc-url",
                RPC_URL,
                "--network-passphrase",
                NETWORK_PASSPHRASE,
            ],
            true,
        )?;
        Ok(())
    }

    fn ensure_testnet_profile(&self) -> Result<()> {
        if self.run_stellar(["network", "passphrase", TESTNET_NAME], true).is_ok() {
            return Ok(());
        }
        self.run_stellar(
            [
                "network",
                "add",
                TESTNET_NAME,
                "--rpc-url",
                TESTNET_RPC_URL,
                "--network-passphrase",
                TESTNET_NETWORK_PASSPHRASE,
            ],
            true,
        )?;
        Ok(())
    }

    fn ensure_accounts(
        &self,
        configs: &[ParticipantConfig],
    ) -> Result<BTreeMap<String, String>> {
        let mut out = BTreeMap::new();
        for cfg in configs {
            self.run_stellar(["keys", "generate", cfg.name, "--overwrite"], true)?;
            self.run_stellar(["keys", "fund", cfg.name, "-n", NETWORK_NAME], true)?;
            let address = self
                .run_stellar(["keys", "public-key", cfg.name], true)?
                .trim()
                .to_string();
            out.insert(cfg.name.to_string(), address);
        }
        Ok(out)
    }

    fn ensure_accounts_on(
        &self,
        configs: &[ParticipantConfig],
        network: &str,
    ) -> Result<BTreeMap<String, String>> {
        let mut out = BTreeMap::new();
        for cfg in configs {
            self.run_stellar(["keys", "generate", cfg.name, "--overwrite"], true)?;
            self.run_stellar(["keys", "fund", cfg.name, "-n", network], true)?;
            let address = self
                .run_stellar(["keys", "public-key", cfg.name], true)?
                .trim()
                .to_string();
            out.insert(cfg.name.to_string(), address);
        }
        Ok(out)
    }

    fn build_wasms(&self) -> Result<()> {
        for package in [
            "nyx-account-policy",
            "nyx-confidential-auditor",
            "nyx-confidential-verifier",
            "nyx-demo-fungible-token",
            "nyx-confidential-token",
        ] {
            self.run_stellar(
                [
                    "contract",
                    "build",
                    "--manifest-path",
                    self.root.join("Cargo.toml").to_str().unwrap(),
                    "--package",
                    package,
                    "--out-dir",
                    self.wasm_dir.to_str().unwrap(),
                ],
                true,
            )
            .with_context(|| format!("failed to build wasm for {package}"))?;
        }
        Ok(())
    }

    fn build_phase3_wasms(&self) -> Result<()> {
        for package in [
            "nyx-demo-fungible-token",
            "nyx-participant-policy",
            "nyx-collateral-policy-registry",
            "nyx-oracle-adapter",
            "nyx-collateral-lock-registry",
            "nyx-collateral-sufficiency-verifier",
            "nyx-prefunding-credit-line",
        ] {
            self.run_stellar(
                [
                    "contract",
                    "build",
                    "--manifest-path",
                    self.root.join("Cargo.toml").to_str().unwrap(),
                    "--package",
                    package,
                    "--out-dir",
                    self.wasm_dir.to_str().unwrap(),
                ],
                true,
            )
            .with_context(|| format!("failed to build wasm for {package}"))?;
        }
        Ok(())
    }

    fn build_phase6_wasms(&self) -> Result<()> {
        for package in [
            "nyx-repayment-history-verifier",
            "nyx-repayment-history-registry",
            "nyx-disclosure-grant-registry",
        ] {
            self.run_stellar(
                [
                    "contract",
                    "build",
                    "--manifest-path",
                    self.root.join("Cargo.toml").to_str().unwrap(),
                    "--package",
                    package,
                    "--out-dir",
                    self.wasm_dir.to_str().unwrap(),
                ],
                true,
            )
            .with_context(|| format!("failed to build wasm for {package}"))?;
        }
        Ok(())
    }

    fn deploy_phase3_contracts(
        &self,
        network: &str,
        addrs: &BTreeMap<String, String>,
    ) -> Result<Phase3DeploymentSet> {
        let admin = addrs["admin"].as_str();
        let mock_ctbill = self.deploy_demo_token_on(network, "mock-cTBill", admin)?;
        let participant_policy = self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-participant-policy"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
            ],
        )?;
        let collateral_policy_registry = self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-collateral-policy-registry"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
            ],
        )?;
        let oracle_adapter = self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-oracle-adapter"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
            ],
        )?;
        let collateral_lock_registry = self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-collateral-lock-registry"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
            ],
        )?;
        let prefunding_credit_line = self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-prefunding-credit-line"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
                "--participant-policy".to_string(),
                participant_policy.clone(),
                "--collateral-policy-registry".to_string(),
                collateral_policy_registry.clone(),
                "--collateral-lock-registry".to_string(),
                collateral_lock_registry.clone(),
            ],
        )?;

        Ok(Phase3DeploymentSet {
            participant_policy,
            collateral_policy_registry,
            oracle_adapter,
            collateral_lock_registry,
            collateral_sufficiency_verifier: None,
            prefunding_credit_line,
            mock_ctbill,
        })
    }

    fn deploy_phase4_contracts(
        &self,
        network: &str,
        addrs: &BTreeMap<String, String>,
        vk_path: &Path,
    ) -> Result<Phase4DeploymentSet> {
        let admin = addrs["admin"].as_str();
        let mock_ctbill = self.deploy_demo_token_on(network, "mock-cTBill", admin)?;
        let collateral_sufficiency_verifier = self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-collateral-sufficiency-verifier"),
            "admin",
            vec![
                "--vk-bytes-file-path".to_string(),
                vk_path.to_string_lossy().to_string(),
            ],
        )?;
        let participant_policy = self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-participant-policy"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
            ],
        )?;
        let collateral_policy_registry = self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-collateral-policy-registry"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
            ],
        )?;
        let oracle_adapter = self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-oracle-adapter"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
            ],
        )?;
        let collateral_lock_registry = self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-collateral-lock-registry"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
            ],
        )?;
        let prefunding_credit_line = self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-prefunding-credit-line"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
                "--participant-policy".to_string(),
                participant_policy.clone(),
                "--collateral-policy-registry".to_string(),
                collateral_policy_registry.clone(),
                "--collateral-lock-registry".to_string(),
                collateral_lock_registry.clone(),
                "--cs-verifier".to_string(),
                collateral_sufficiency_verifier.clone(),
            ],
        )?;

        Ok(Phase4DeploymentSet {
            participant_policy,
            collateral_policy_registry,
            oracle_adapter,
            collateral_lock_registry,
            collateral_sufficiency_verifier,
            prefunding_credit_line,
            mock_ctbill,
        })
    }

    fn deploy_phase6_contracts(
        &self,
        network: &str,
        admin: &str,
        vk_path: &Path,
    ) -> Result<Phase6DeploymentSet> {
        let repayment_history_verifier = self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-repayment-history-verifier"),
            "admin",
            vec![
                "--vk-bytes-file-path".to_string(),
                vk_path.to_string_lossy().to_string(),
            ],
        )?;
        let repayment_history_registry = self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-repayment-history-registry"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
                "--verifier".to_string(),
                repayment_history_verifier.clone(),
            ],
        )?;
        let disclosure_grant_registry = self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-disclosure-grant-registry"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
            ],
        )?;
        Ok(Phase6DeploymentSet {
            repayment_history_verifier,
            repayment_history_registry,
            disclosure_grant_registry,
        })
    }

    fn deploy_demo_token_on(&self, network: &str, symbol: &str, admin: &str) -> Result<String> {
        self.deploy_wasm_on(
            network,
            self.wasm_path("nyx-demo-fungible-token"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
                "--decimals".to_string(),
                "6".to_string(),
                "--name".to_string(),
                symbol.to_string(),
                "--symbol".to_string(),
                symbol.to_string(),
            ],
        )
    }

    fn deploy_contracts(&self, addrs: &BTreeMap<String, String>) -> Result<DeploymentSet> {
        let admin = addrs["admin"].as_str();
        let policy = self.deploy_wasm(
            self.wasm_path("nyx-account-policy"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
            ],
        )?;
        let auditor_registry = self.deploy_wasm(
            self.wasm_path("nyx-confidential-auditor"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
            ],
        )?;
        let verifier_registry = self.deploy_wasm(
            self.wasm_path("nyx-confidential-verifier"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
            ],
        )?;

        let tusdc = self.deploy_demo_token("tUSDC", admin)?;
        let ttbill = self.deploy_demo_token("tTBill", admin)?;
        let txaum = self.deploy_demo_token("tXAUm", admin)?;

        let cusdc = self.deploy_confidential_token(admin, &tusdc, &verifier_registry, &auditor_registry, &policy)?;
        let ctbill =
            self.deploy_confidential_token(admin, &ttbill, &verifier_registry, &auditor_registry, &policy)?;
        let cxaum =
            self.deploy_confidential_token(admin, &txaum, &verifier_registry, &auditor_registry, &policy)?;

        Ok(DeploymentSet {
            policy,
            auditor_registry,
            verifier_registry,
            tusdc,
            ttbill,
            txaum,
            cusdc,
            ctbill,
            cxaum,
        })
    }

    fn deploy_demo_token(&self, symbol: &str, admin: &str) -> Result<String> {
        self.deploy_wasm(
            self.wasm_path("nyx-demo-fungible-token"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
                "--decimals".to_string(),
                "6".to_string(),
                "--name".to_string(),
                symbol.to_string(),
                "--symbol".to_string(),
                symbol.to_string(),
            ],
        )
    }

    fn deploy_confidential_token(
        &self,
        admin: &str,
        underlying_asset: &str,
        verifier: &str,
        auditor: &str,
        policy: &str,
    ) -> Result<String> {
        self.deploy_wasm(
            self.wasm_path("nyx-confidential-token"),
            "admin",
            vec![
                "--admin".to_string(),
                admin.to_string(),
                "--manager".to_string(),
                admin.to_string(),
                "--underlying-asset".to_string(),
                underlying_asset.to_string(),
                "--verifier".to_string(),
                verifier.to_string(),
                "--auditor".to_string(),
                auditor.to_string(),
                "--policy".to_string(),
                policy.to_string(),
            ],
        )
    }

    fn deploy_wasm(&self, wasm_path: PathBuf, source: &str, ctor_args: Vec<String>) -> Result<String> {
        self.deploy_wasm_on(NETWORK_NAME, wasm_path, source, ctor_args)
    }

    fn deploy_wasm_on(
        &self,
        network: &str,
        wasm_path: PathBuf,
        source: &str,
        ctor_args: Vec<String>,
    ) -> Result<String> {
        let mut args = vec![
            "contract".to_string(),
            "deploy".to_string(),
            "--wasm".to_string(),
            wasm_path.to_string_lossy().to_string(),
            "--source-account".to_string(),
            source.to_string(),
            "-n".to_string(),
            network.to_string(),
            "--".to_string(),
        ];
        args.extend(ctor_args);
        let stdout = self.run_stellar_owned(args, true)?;
        Ok(stdout.lines().last().unwrap_or(stdout.trim()).trim().to_string())
    }

    fn invoke_phase3(
        &self,
        network: &str,
        contract_id: &str,
        source: &str,
        function: &str,
        mut fn_args: Vec<String>,
        check: bool,
    ) -> Result<String> {
        let mut args = vec![
            "contract".to_string(),
            "invoke".to_string(),
            "--id".to_string(),
            contract_id.to_string(),
            "--source-account".to_string(),
            source.to_string(),
            "-n".to_string(),
            network.to_string(),
            "--".to_string(),
            function.to_string(),
        ];
        args.append(&mut fn_args);
        self.run_stellar_owned(args, check)
    }

    fn set_participant(
        &self,
        network: &str,
        policy: &str,
        account: &str,
        approved: bool,
        admin_addr: &str,
    ) -> Result<()> {
        self.invoke_phase3(
            network,
            policy,
            "admin",
            "set_participant",
            vec![
                "--account".to_string(),
                account.to_string(),
                "--approved".to_string(),
                approved.to_string(),
                "--role-mask".to_string(),
                "1".to_string(),
                "--risk-tier".to_string(),
                if approved { "1" } else { "9" }.to_string(),
                "--expires-ledger".to_string(),
                "0".to_string(),
                "--operator".to_string(),
                admin_addr.to_string(),
            ],
            true,
        )?;
        Ok(())
    }

    fn set_oracle_price(
        &self,
        network: &str,
        oracle: &str,
        asset: &str,
        price_e7: i128,
        updated_ledger: u32,
        admin_addr: &str,
    ) -> Result<()> {
        self.invoke_phase3(
            network,
            oracle,
            "admin",
            "set_price",
            vec![
                "--asset".to_string(),
                asset.to_string(),
                "--price-e7".to_string(),
                price_e7.to_string(),
                "--updated-ledger".to_string(),
                updated_ledger.to_string(),
                "--operator".to_string(),
                admin_addr.to_string(),
            ],
            true,
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn set_collateral_policy(
        &self,
        network: &str,
        registry: &str,
        collateral_token: &str,
        eligible: bool,
        haircut_bps: u32,
        max_tenor_days: u32,
        oracle: &str,
        max_staleness_ledgers: u32,
        admin_addr: &str,
    ) -> Result<()> {
        self.invoke_phase3(
            network,
            registry,
            "admin",
            "set_policy",
            vec![
                "--collateral-token".to_string(),
                collateral_token.to_string(),
                "--eligible".to_string(),
                eligible.to_string(),
                "--haircut-bps".to_string(),
                haircut_bps.to_string(),
                "--max-tenor-days".to_string(),
                max_tenor_days.to_string(),
                "--oracle".to_string(),
                oracle.to_string(),
                "--max-staleness-ledgers".to_string(),
                max_staleness_ledgers.to_string(),
                "--operator".to_string(),
                admin_addr.to_string(),
            ],
            true,
        )?;
        Ok(())
    }

    fn set_approved_proof(
        &self,
        network: &str,
        credit_line: &str,
        proof_hash: &str,
        approved: bool,
        admin_addr: &str,
    ) -> Result<()> {
        self.invoke_phase3(
            network,
            credit_line,
            "admin",
            "set_approved_proof",
            vec![
                "--proof-hash".to_string(),
                proof_hash.to_string(),
                "--approved".to_string(),
                approved.to_string(),
                "--operator".to_string(),
                admin_addr.to_string(),
            ],
            true,
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn open_credit(
        &self,
        network: &str,
        credit_line: &str,
        position_id: &str,
        anchor: &str,
        collateral_token: &str,
        lock_key: &str,
        credit_amount: i128,
        collateral_amount: i128,
        tenor_days: u32,
        proof_hash: &str,
        admin_addr: &str,
        expect_success: bool,
    ) -> Result<String> {
        let result = self.invoke_phase3(
            network,
            credit_line,
            "admin",
            "open_credit",
            vec![
                "--position-id".to_string(),
                position_id.to_string(),
                "--anchor".to_string(),
                anchor.to_string(),
                "--collateral-token".to_string(),
                collateral_token.to_string(),
                "--lock-key".to_string(),
                lock_key.to_string(),
                "--credit-amount".to_string(),
                credit_amount.to_string(),
                "--collateral-amount".to_string(),
                collateral_amount.to_string(),
                "--tenor-days".to_string(),
                tenor_days.to_string(),
                "--proof-hash".to_string(),
                proof_hash.to_string(),
                "--operator".to_string(),
                admin_addr.to_string(),
            ],
            expect_success,
        );
        match result {
            Ok(stdout) => Ok(stdout),
            Err(err) if !expect_success => Ok(format!("{err:#}")),
            Err(err) => Err(err),
        }
    }

    fn repay_credit(
        &self,
        network: &str,
        credit_line: &str,
        position_id: &str,
        admin_addr: &str,
    ) -> Result<()> {
        self.invoke_phase3(
            network,
            credit_line,
            "admin",
            "repay",
            vec![
                "--position-id".to_string(),
                position_id.to_string(),
                "--repayment-commitment".to_string(),
                "9999999999999999999999999999999999999999999999999999999999999999".to_string(),
                "--operator".to_string(),
                admin_addr.to_string(),
            ],
            true,
        )?;
        Ok(())
    }

    fn assert_revoke_allowed(
        &self,
        network: &str,
        lock_registry: &str,
        lock_key: &str,
        expect_success: bool,
    ) -> Result<String> {
        let result = self.invoke_phase3(
            network,
            lock_registry,
            "admin",
            "assert_revoke_allowed",
            vec!["--lock-key".to_string(), lock_key.to_string()],
            expect_success,
        );
        match result {
            Ok(stdout) => Ok(stdout),
            Err(err) if !expect_success => Ok(format!("{err:#}")),
            Err(err) => Err(err),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn open_credit_with_proof(
        &self,
        network: &str,
        credit_line: &str,
        position_id: &str,
        anchor: &str,
        collateral_token: &str,
        artifacts: &CollateralProofArtifacts,
        public_inputs: &[u8],
        proof: &[u8],
        admin_addr: &str,
        expect_success: bool,
    ) -> Result<String> {
        let public_inputs_file = write_temp_file(public_inputs)?;
        let proof_file = write_temp_file(proof)?;
        let result = self.invoke_phase3(
            network,
            credit_line,
            "admin",
            "open_credit",
            vec![
                "--position-id".to_string(),
                position_id.to_string(),
                "--anchor".to_string(),
                anchor.to_string(),
                "--collateral-token".to_string(),
                collateral_token.to_string(),
                "--lock-key".to_string(),
                field_to_hex(&artifacts.lock_key),
                "--collateral-commitment-x".to_string(),
                field_to_hex(&point_x(&self.env, &artifacts.collateral_commitment)),
                "--collateral-commitment-y".to_string(),
                field_to_hex(&point_y(&self.env, &artifacts.collateral_commitment)),
                "--credit-commitment-x".to_string(),
                field_to_hex(&point_x(&self.env, &artifacts.credit_commitment)),
                "--credit-commitment-y".to_string(),
                field_to_hex(&point_y(&self.env, &artifacts.credit_commitment)),
                "--oracle-price-e7".to_string(),
                artifacts.oracle_price_e7.to_string(),
                "--haircut-bps".to_string(),
                artifacts.haircut_bps.to_string(),
                "--tenor-days".to_string(),
                artifacts.tenor_days.to_string(),
                "--position-nullifier".to_string(),
                field_to_hex(&artifacts.position_nullifier),
                "--public-inputs-file-path".to_string(),
                public_inputs_file.path().to_string_lossy().to_string(),
                "--proof-file-path".to_string(),
                proof_file.path().to_string_lossy().to_string(),
                "--operator".to_string(),
                admin_addr.to_string(),
            ],
            expect_success,
        );
        match result {
            Ok(stdout) => Ok(stdout),
            Err(err) if !expect_success => Ok(format!("{err:#}")),
            Err(err) => Err(err),
        }
    }

    fn register_auditor_key(&self, registry: &str, admin_addr: &str) -> Result<()> {
        let auditor_pub = point_mul_big(&self.env, &h_point(&self.env), &BigUint::from(55u32));
        let key_file = write_temp_file(&point_to_bytes(&auditor_pub))?;
        self.run_stellar_owned(
            vec![
                "contract".to_string(),
                "invoke".to_string(),
                "--id".to_string(),
                registry.to_string(),
                "--source-account".to_string(),
                "admin".to_string(),
                "-n".to_string(),
                NETWORK_NAME.to_string(),
                "--".to_string(),
                "register_key".to_string(),
                "--auditor-id".to_string(),
                AUDITOR_ID.to_string(),
                "--point-file-path".to_string(),
                key_file.path().to_string_lossy().to_string(),
                "--operator".to_string(),
                admin_addr.to_string(),
            ],
            true,
        )?;
        Ok(())
    }

    fn register_verification_keys(&self, registry: &str, admin_addr: &str) -> Result<()> {
        let variants = [
            (0u32, "Register", "register.vk.bin"),
            (1u32, "Withdraw", "withdraw.vk.bin"),
            (2u32, "Transfer", "transfer.vk.bin"),
            (3u32, "SpenderTransfer", "spender_transfer.vk.bin"),
            (4u32, "SetSpender", "set_spender.vk.bin"),
            (5u32, "RevokeSpender", "revoke_spender.vk.bin"),
        ];
        for (variant_id, variant_name, file) in variants {
            eprintln!("   -> verifier key: {variant_name}");
            self.run_stellar_owned(
                vec![
                    "contract".to_string(),
                    "invoke".to_string(),
                    "--id".to_string(),
                    registry.to_string(),
                    "--source-account".to_string(),
                    "admin".to_string(),
                    "-n".to_string(),
                    NETWORK_NAME.to_string(),
                    "--".to_string(),
                    "register_verification_key_u32".to_string(),
                    "--circuit-type".to_string(),
                    variant_id.to_string(),
                    "--vk-file-path".to_string(),
                    self.circuits_dir.join("vks").join(file).to_string_lossy().to_string(),
                    "--operator".to_string(),
                    admin_addr.to_string(),
                ],
                true,
            )
            .with_context(|| format!("register_verification_key failed for {variant_name}"))?;
        }
        Ok(())
    }

    fn initialize_actors(
        &self,
        configs: &[ParticipantConfig],
        addrs: &BTreeMap<String, String>,
    ) -> Result<BTreeMap<String, Actor>> {
        let mut actors = BTreeMap::new();
        for cfg in configs.iter().filter(|cfg| cfg.name != "admin") {
            actors.insert(
                cfg.name.to_string(),
                Actor {
                    name: cfg.name,
                    stellar_address: addrs[cfg.name].clone(),
                    sk: BigUint::from(cfg.sk),
                    y: point_mul_big(&self.env, &h_point(&self.env), &BigUint::from(cfg.sk)),
                    per_token: BTreeMap::new(),
                },
            );
        }
        Ok(actors)
    }

    fn token_contexts(&self, deployments: &DeploymentSet) -> Vec<TokenContext> {
        vec![
            TokenContext {
                name: "cUSDC",
                symbol: "tUSDC",
                public_token: deployments.tusdc.clone(),
                confidential_token: deployments.cusdc.clone(),
                addr_f: address_to_field(&self.env, &deployments.cusdc),
            },
            TokenContext {
                name: "cTBill",
                symbol: "tTBill",
                public_token: deployments.ttbill.clone(),
                confidential_token: deployments.ctbill.clone(),
                addr_f: address_to_field(&self.env, &deployments.ctbill),
            },
            TokenContext {
                name: "cXAUm",
                symbol: "tXAUm",
                public_token: deployments.txaum.clone(),
                confidential_token: deployments.cxaum.clone(),
                addr_f: address_to_field(&self.env, &deployments.cxaum),
            },
        ]
    }

    fn register_accounts(
        &self,
        actors: &mut BTreeMap<String, Actor>,
        tokens: &[TokenContext],
        addrs: &BTreeMap<String, String>,
    ) -> Result<()> {
        for token in tokens {
            for actor in actors.values_mut() {
                let state = build_zeroed_account_state(&self.env, &actor.sk, &token.addr_f);
                let proof_dir = self.state_dir.join(format!("register-{}-{}", token.name, actor.name));
                self.run_register_proof(&actor.sk, &actor.y, &state, &token.addr_f, &proof_dir)?;

                let payload = RegisterData {
                    payload: RegisterPayload { y: state_to_y(actor), pvk: state.pvk.clone() },
                    proof: Bytes::from_slice(&self.env, &fs::read(proof_dir.join("proof"))?),
                };
                let data = payload.to_xdr(&self.env);
                let data_file = write_temp_file(data.to_alloc_vec().as_slice())?;

                self.run_stellar_owned(
                    vec![
                        "contract".to_string(),
                        "invoke".to_string(),
                        "--id".to_string(),
                        token.confidential_token.clone(),
                        "--source-account".to_string(),
                        actor.name.to_string(),
                        "-n".to_string(),
                        NETWORK_NAME.to_string(),
                        "--".to_string(),
                        "register".to_string(),
                        "--account".to_string(),
                        addrs[actor.name].clone(),
                        "--auditor-id".to_string(),
                        AUDITOR_ID.to_string(),
                        "--data-file-path".to_string(),
                        data_file.path().to_string_lossy().to_string(),
                    ],
                    true,
                )?;
                actor.per_token.insert(token.confidential_token.clone(), state);
            }
        }
        Ok(())
    }

    fn seed_public_balances(
        &self,
        deployments: &DeploymentSet,
        addrs: &BTreeMap<String, String>,
    ) -> Result<()> {
        for token in [&deployments.tusdc, &deployments.ttbill, &deployments.txaum] {
            self.mint_public(token, &addrs["alpha"], 10_000, &addrs["admin"])?;
            self.mint_public(token, &addrs["facility"], 2_000, &addrs["admin"])?;
            self.mint_public(token, &addrs["credit-executor"], 500, &addrs["admin"])?;
        }
        Ok(())
    }

    fn mint_public(&self, token: &str, to: &str, amount: i128, admin_addr: &str) -> Result<()> {
        self.run_stellar_owned(
            vec![
                "contract".to_string(),
                "invoke".to_string(),
                "--id".to_string(),
                token.to_string(),
                "--source-account".to_string(),
                "admin".to_string(),
                "-n".to_string(),
                NETWORK_NAME.to_string(),
                "--".to_string(),
                "mint".to_string(),
                "--to".to_string(),
                to.to_string(),
                "--amount".to_string(),
                amount.to_string(),
                "--operator".to_string(),
                admin_addr.to_string(),
            ],
            true,
        )?;
        Ok(())
    }

    fn deposit(&self, token: &str, source_identity: &str, source_addr: &str, amount: i128) -> Result<()> {
        self.run_stellar_owned(
            vec![
                "contract".to_string(),
                "invoke".to_string(),
                "--id".to_string(),
                token.to_string(),
                "--source-account".to_string(),
                source_identity.to_string(),
                "-n".to_string(),
                NETWORK_NAME.to_string(),
                "--".to_string(),
                "deposit".to_string(),
                "--from".to_string(),
                source_addr.to_string(),
                "--to".to_string(),
                source_addr.to_string(),
                "--amount".to_string(),
                amount.to_string(),
            ],
            true,
        )?;
        Ok(())
    }

    fn merge(&self, token: &str, identity: &str) -> Result<()> {
        let addr = self.run_stellar(["keys", "public-key", identity], true)?.trim().to_string();
        self.run_stellar_owned(
            vec![
                "contract".to_string(),
                "invoke".to_string(),
                "--id".to_string(),
                token.to_string(),
                "--source-account".to_string(),
                identity.to_string(),
                "-n".to_string(),
                NETWORK_NAME.to_string(),
                "--".to_string(),
                "merge".to_string(),
                "--account".to_string(),
                addr,
            ],
            true,
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn confidential_transfer(
        &self,
        token: &TokenContext,
        from: &mut Actor,
        to: &mut Actor,
        amount: u128,
        from_addr: &str,
        op: &OperationScalars,
    ) -> Result<TransferArtifacts> {
        let from_name = from.name.to_string();
        let from_state = from.account(token).clone();
        let recipient_state = to.account(token).clone();
        let sigma = BigUint::from(op.sigma);
        let r_e = BigUint::from(op.r_e);
        let vk = from_state.vk.clone();
        let v_new = from_state.spendable_value.checked_sub(amount).context("insufficient spendable value")?;
        let s_x = ecdh_x(&self.env, &recipient_state.pvk, &r_e);
        let r_tx = derive_tx_blind(&self.env, &s_x, &sigma);
        let c_tx = commit(&self.env, amount, &r_tx);
        let r_new = derive_spend_r(&self.env, &vk, &sigma);
        let c_spend_new = commit(&self.env, v_new, &r_new);
        let b_tilde = encrypt_balance(&self.env, v_new, &vk, &sigma);
        let v_tilde = encrypt_amount(&self.env, amount, &s_x, &sigma);
        let r_e_point = point_mul_big(&self.env, &h_point(&self.env), &r_e);
        let auditor_pub = point_mul_big(&self.env, &h_point(&self.env), &BigUint::from(55u32));
        let (mask_r0, mask_r1) = sponge_squeeze_2(&self.env, DOMAIN_AUDITOR_RECIPIENT, &ecdh_x(&self.env, &auditor_pub, &r_e), &sigma);
        let (mask_s0, mask_s1) = sponge_squeeze_2(&self.env, DOMAIN_AUDITOR_SENDER, &ecdh_x(&self.env, &auditor_pub, &r_e), &sigma);
        let v_aud_r = field_add_u128(&mask_r0, amount);
        let r_aud_r = field_add(&mask_r1, &r_tx);
        let v_aud_s = field_add_u128(&mask_s0, amount);
        let b_aud_s = field_add_u128(&mask_s1, v_new);

        self.run_transfer_proof(
            from,
            &recipient_state,
            token,
            amount,
            &sigma,
            &r_e,
            &auditor_pub,
            &c_spend_new,
            &c_tx,
            &r_e_point,
            &v_tilde,
            &b_tilde,
            &v_aud_r,
            &r_aud_r,
            &v_aud_s,
            &b_aud_s,
        )?;

        let proof_bytes = fs::read(self.state_dir.join("proof-transfer").join("proof"))?;
        let payload = TransferData {
            payload: TransferPayload {
                c_spend_new: c_spend_new.clone(),
                c_tx: c_tx.clone(),
                r_e: r_e_point.clone(),
                v_tilde: field_to_bytesn(&self.env, &v_tilde),
                b_tilde: field_to_bytesn(&self.env, &b_tilde),
                sigma: field_to_bytesn(&self.env, &sigma),
                v_aud_r: field_to_bytesn(&self.env, &v_aud_r),
                r_aud_r: field_to_bytesn(&self.env, &r_aud_r),
                v_aud_s: field_to_bytesn(&self.env, &v_aud_s),
                b_aud_s: field_to_bytesn(&self.env, &b_aud_s),
            },
            proof: Bytes::from_slice(&self.env, &proof_bytes),
        };
        let data = payload.to_xdr(&self.env);
        let file = write_temp_file(data.to_alloc_vec().as_slice())?;
        self.run_stellar_owned(
            vec![
                "contract".to_string(),
                "invoke".to_string(),
                "--id".to_string(),
                token.confidential_token.clone(),
                "--source-account".to_string(),
                from_name,
                "-n".to_string(),
                NETWORK_NAME.to_string(),
                "--".to_string(),
                "confidential_transfer".to_string(),
                "--from".to_string(),
                from_addr.to_string(),
                "--to".to_string(),
                to.stellar_address.clone(),
                "--data-file-path".to_string(),
                file.path().to_string_lossy().to_string(),
            ],
            true,
        )?;

        let from_state = from.account_mut(token);
        from_state.spendable_value = v_new;
        from_state.spendable_r = r_new.clone();
        from_state.spendable_balance = c_spend_new.clone();
        let recipient_mut = to.account_mut(token);
        recipient_mut.receiving_value += amount;
        recipient_mut.receiving_r = field_add(&recipient_mut.receiving_r, &r_tx);
        recipient_mut.receiving_balance =
            Grumpkin::add(&self.env, &recipient_mut.receiving_balance, &c_tx);

        Ok(TransferArtifacts {
            amount,
            sigma,
            r_e_point,
            v_aud_r,
            r_aud_r,
            v_aud_s,
            b_aud_s,
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn try_confidential_transfer(
        &self,
        token: &TokenContext,
        from: &Actor,
        to: &Actor,
        amount: u128,
        from_addr: &str,
        op: &OperationScalars,
    ) -> Result<String> {
        let from_state = from.account(token);
        let recipient_state = to.account(token);
        let sigma = BigUint::from(op.sigma);
        let r_e = BigUint::from(op.r_e);
        let vk = from_state.vk.clone();
        let v_new = from_state.spendable_value.checked_sub(amount).context("insufficient value for blocked test")?;
        let s_x = ecdh_x(&self.env, &recipient_state.pvk, &r_e);
        let r_tx = derive_tx_blind(&self.env, &s_x, &sigma);
        let c_tx = commit(&self.env, amount, &r_tx);
        let r_new = derive_spend_r(&self.env, &vk, &sigma);
        let c_spend_new = commit(&self.env, v_new, &r_new);
        let b_tilde = encrypt_balance(&self.env, v_new, &vk, &sigma);
        let v_tilde = encrypt_amount(&self.env, amount, &s_x, &sigma);
        let auditor_pub = point_mul_big(&self.env, &h_point(&self.env), &BigUint::from(55u32));
        let (mask_r0, mask_r1) = sponge_squeeze_2(&self.env, DOMAIN_AUDITOR_RECIPIENT, &ecdh_x(&self.env, &auditor_pub, &r_e), &sigma);
        let (mask_s0, mask_s1) = sponge_squeeze_2(&self.env, DOMAIN_AUDITOR_SENDER, &ecdh_x(&self.env, &auditor_pub, &r_e), &sigma);
        let payload = TransferData {
            payload: TransferPayload {
                c_spend_new,
                c_tx,
                r_e: point_mul_big(&self.env, &h_point(&self.env), &r_e),
                v_tilde: field_to_bytesn(&self.env, &v_tilde),
                b_tilde: field_to_bytesn(&self.env, &b_tilde),
                sigma: field_to_bytesn(&self.env, &sigma),
                v_aud_r: field_to_bytesn(&self.env, &field_add_u128(&mask_r0, amount)),
                r_aud_r: field_to_bytesn(&self.env, &field_add(&mask_r1, &r_tx)),
                v_aud_s: field_to_bytesn(&self.env, &field_add_u128(&mask_s0, amount)),
                b_aud_s: field_to_bytesn(&self.env, &field_add_u128(&mask_s1, v_new)),
            },
            proof: Bytes::new(&self.env),
        };
        let data = payload.to_xdr(&self.env);
        let file = write_temp_file(data.to_alloc_vec().as_slice())?;
        match self.run_stellar_owned(
            vec![
                "contract".to_string(),
                "invoke".to_string(),
                "--id".to_string(),
                token.confidential_token.clone(),
                "--source-account".to_string(),
                from.name.to_string(),
                "-n".to_string(),
                NETWORK_NAME.to_string(),
                "--".to_string(),
                "confidential_transfer".to_string(),
                "--from".to_string(),
                from_addr.to_string(),
                "--to".to_string(),
                to.stellar_address.clone(),
                "--data-file-path".to_string(),
                file.path().to_string_lossy().to_string(),
            ],
            false,
        ) {
            Ok(stdout) => Ok(format!("unexpected success: {}", stdout.trim())),
            Err(err) => Ok(format!("{err:#}")),
        }
    }

    fn set_spender(
        &self,
        token: &TokenContext,
        owner: &mut Actor,
        spender: &Actor,
        amount: u128,
        live_until_ledger: u32,
        owner_addr: &str,
        op: &OperationScalars,
    ) -> Result<()> {
        eprintln!(
            "   -> set_spender current ledger={}, live_until={}",
            self.current_ledger()?,
            live_until_ledger
        );
        let owner_name = owner.name.to_string();
        let state = owner.account(token).clone();
        let sigma = BigUint::from(op.sigma);
        let sigma_a = BigUint::from(op.sigma_alt.ok_or_else(|| anyhow!("missing sigma_a"))?);
        let r_e = BigUint::from(op.r_e);
        let op_i = address_to_field(&self.env, &spender.stellar_address);
        let dvk = dvk_from_vk_op(&self.env, &state.vk, &op_i);
        let r_a = derive_allow_r(&self.env, &dvk, &sigma_a);
        let c_a = commit(&self.env, amount, &r_a);
        let v_new = state.spendable_value.checked_sub(amount).context("insufficient balance for set_spender")?;
        let r_new = derive_spend_r(&self.env, &state.vk, &sigma);
        let c_spend_new = commit(&self.env, v_new, &r_new);
        let b_tilde = encrypt_balance(&self.env, v_new, &state.vk, &sigma);
        let a_tilde = encrypt_allowance(&self.env, amount, &dvk, &sigma_a);
        let r_e_point = point_mul_big(&self.env, &h_point(&self.env), &r_e);
        let s_esc = ecdh_x(&self.env, &spender.y, &r_e);
        let escrowed_cipher = encrypt_escrowed_dvk(&self.env, &dvk, &s_esc, &op_i);
        let escrowed_dvk = encode_noncurve_pair(&self.env, &point_x(&self.env, &r_e_point), &escrowed_cipher);
        let auditor_pub = point_mul_big(&self.env, &h_point(&self.env), &BigUint::from(55u32));
        let (mask0, mask1) =
            sponge_squeeze_2(&self.env, DOMAIN_AUDITOR_SENDER, &ecdh_x(&self.env, &auditor_pub, &r_e), &sigma);
        let v_aud_s = field_add_u128(&mask0, amount);
        let b_aud_s = field_add_u128(&mask1, v_new);

        self.run_set_spender_proof(
            owner,
            spender,
            token,
            amount,
            &sigma,
            &sigma_a,
            &r_e,
            &auditor_pub,
            &c_spend_new,
            &c_a,
            &escrowed_dvk,
            &b_tilde,
            &a_tilde,
            &r_e_point,
            &v_aud_s,
            &b_aud_s,
        )?;

        let payload = SetSpenderData {
            payload: SetSpenderPayload {
                c_spend_new: c_spend_new.clone(),
                c_a: c_a.clone(),
                escrowed_dvk: escrowed_dvk.clone(),
                b_tilde: field_to_bytesn(&self.env, &b_tilde),
                a_tilde: field_to_bytesn(&self.env, &a_tilde),
                r_e: r_e_point,
                sigma: field_to_bytesn(&self.env, &sigma),
                sigma_a: field_to_bytesn(&self.env, &sigma_a),
                v_aud_s: field_to_bytesn(&self.env, &v_aud_s),
                b_aud_s: field_to_bytesn(&self.env, &b_aud_s),
            },
            proof: Bytes::from_slice(&self.env, &fs::read(self.state_dir.join("proof-set-spender").join("proof"))?),
        };
        let data = payload.to_xdr(&self.env);
        let file = write_temp_file(data.to_alloc_vec().as_slice())?;

        self.run_stellar_owned(
            vec![
                "contract".to_string(),
                "invoke".to_string(),
                "--id".to_string(),
                token.confidential_token.clone(),
                "--source-account".to_string(),
                owner_name,
                "-n".to_string(),
                NETWORK_NAME.to_string(),
                "--".to_string(),
                "set_spender".to_string(),
                "--account".to_string(),
                owner_addr.to_string(),
                "--spender".to_string(),
                spender.stellar_address.clone(),
                "--live-until-ledger".to_string(),
                live_until_ledger.to_string(),
                "--data-file-path".to_string(),
                file.path().to_string_lossy().to_string(),
            ],
            true,
        )?;
        eprintln!(
            "   -> on-chain is_spender after set_spender: {}",
            self.is_spender(&token.confidential_token, owner_addr, &spender.stellar_address)?
        );

        let state = owner.account_mut(token);
        state.spendable_value = v_new;
        state.spendable_r = r_new;
        state.spendable_balance = c_spend_new;
        state.delegations.insert(
            spender.stellar_address.clone(),
            DelegationState {
                dvk,
                value: amount,
                randomness: r_a,
                commitment: c_a,
                sigma_a,
                escrowed_dvk,
                live_until_ledger,
            },
        );
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn confidential_transfer_from(
        &self,
        token: &TokenContext,
        owner: &mut Actor,
        spender: &Actor,
        recipient: &mut Actor,
        amount: u128,
        spender_addr: &str,
        op: &OperationScalars,
    ) -> Result<()> {
        eprintln!(
            "   -> spender transfer current ledger={} for spender={}",
            self.current_ledger()?,
            spender.stellar_address
        );
        eprintln!(
            "   -> on-chain is_spender before spender transfer: {}",
            self.is_spender(&token.confidential_token, &owner.stellar_address, &spender.stellar_address)?
        );
        let owner_addr = owner.stellar_address.clone();
        let delegation = owner
            .account(token)
            .delegations
            .get(&spender.stellar_address)
            .cloned()
            .ok_or_else(|| anyhow!("delegation missing"))?;
        let sigma_a = delegation.sigma_a.clone();
        let sigma_a_new = BigUint::from(op.sigma_alt.ok_or_else(|| anyhow!("missing sigma_a_new"))?);
        let r_e = BigUint::from(op.r_e);
        let v_new = delegation.value.checked_sub(amount).context("insufficient allowance")?;
        let s_x = ecdh_x(&self.env, &recipient.account(token).pvk, &r_e);
        let r_tx = derive_tx_blind(&self.env, &s_x, &sigma_a);
        let c_tx = commit(&self.env, amount, &r_tx);
        let r_a_new = derive_allow_r(&self.env, &delegation.dvk, &sigma_a_new);
        let c_a_new = commit(&self.env, v_new, &r_a_new);
        let a_tilde_new = encrypt_allowance(&self.env, v_new, &delegation.dvk, &sigma_a_new);
        let r_e_point = point_mul_big(&self.env, &h_point(&self.env), &r_e);
        let auditor_pub = point_mul_big(&self.env, &h_point(&self.env), &BigUint::from(55u32));
        let (mask_r0, mask_r1) = sponge_squeeze_2(&self.env, DOMAIN_AUDITOR_RECIPIENT, &ecdh_x(&self.env, &auditor_pub, &r_e), &sigma_a);
        let (mask_s0, mask_s1) = sponge_squeeze_2(&self.env, DOMAIN_AUDITOR_SENDER, &ecdh_x(&self.env, &auditor_pub, &r_e), &sigma_a);
        let v_aud_r = field_add_u128(&mask_r0, amount);
        let r_aud_r = field_add(&mask_r1, &r_tx);
        let v_aud_s = field_add_u128(&mask_s0, amount);
        let a_aud_s = field_add_u128(&mask_s1, v_new);

        self.run_spender_transfer_proof(
            owner,
            spender,
            recipient,
            token,
            &delegation,
            amount,
            &sigma_a_new,
            &r_e,
            &auditor_pub,
            &c_a_new,
            &c_tx,
            &r_e_point,
            &v_aud_r,
            &r_aud_r,
            &v_aud_s,
            &a_aud_s,
            &a_tilde_new,
        )?;

        let payload = SpenderTransferData {
            payload: SpenderTransferPayload {
                c_a_new: c_a_new.clone(),
                c_tx: c_tx.clone(),
                r_e: r_e_point,
                v_tilde: field_to_bytesn(&self.env, &encrypt_amount(&self.env, amount, &s_x, &sigma_a)),
                a_tilde_new: field_to_bytesn(&self.env, &a_tilde_new),
                sigma_a_new: field_to_bytesn(&self.env, &sigma_a_new),
                v_aud_r: field_to_bytesn(&self.env, &v_aud_r),
                r_aud_r: field_to_bytesn(&self.env, &r_aud_r),
                v_aud_s: field_to_bytesn(&self.env, &v_aud_s),
                a_aud_s: field_to_bytesn(&self.env, &a_aud_s),
            },
            proof: Bytes::from_slice(
                &self.env,
                &fs::read(self.state_dir.join("proof-spender-transfer").join("proof"))?,
            ),
        };
        let data = payload.to_xdr(&self.env);
        let file = write_temp_file(data.to_alloc_vec().as_slice())?;

        self.run_stellar_owned(
            vec![
                "contract".to_string(),
                "invoke".to_string(),
                "--id".to_string(),
                token.confidential_token.clone(),
                "--source-account".to_string(),
                spender.name.to_string(),
                "-n".to_string(),
                NETWORK_NAME.to_string(),
                "--".to_string(),
                "confidential_transfer_from".to_string(),
                "--spender".to_string(),
                spender_addr.to_string(),
                "--from".to_string(),
                owner_addr,
                "--to".to_string(),
                recipient.stellar_address.clone(),
                "--data-file-path".to_string(),
                file.path().to_string_lossy().to_string(),
            ],
            true,
        )?;

        let delegation = owner
            .account_mut(token)
            .delegations
            .get_mut(&spender.stellar_address)
            .ok_or_else(|| anyhow!("delegation missing after transfer"))?;
        delegation.value = v_new;
        delegation.randomness = r_a_new;
        delegation.commitment = c_a_new;
        delegation.sigma_a = sigma_a_new;
        let recipient_state = recipient.account_mut(token);
        recipient_state.receiving_value += amount;
        recipient_state.receiving_r = field_add(&recipient_state.receiving_r, &r_tx);
        recipient_state.receiving_balance =
            Grumpkin::add(&self.env, &recipient_state.receiving_balance, &c_tx);
        Ok(())
    }

    fn revoke_spender(
        &self,
        token: &TokenContext,
        owner: &mut Actor,
        spender: &Actor,
        owner_addr: &str,
        op: &OperationScalars,
    ) -> Result<()> {
        let owner_name = owner.name.to_string();
        let state = owner.account(token).clone();
        let delegation = state
            .delegations
            .get(&spender.stellar_address)
            .cloned()
            .ok_or_else(|| anyhow!("delegation missing"))?;
        let sigma = BigUint::from(op.sigma);
        let r_e = BigUint::from(op.r_e);
        let v_new = state.spendable_value + delegation.value;
        let r_new = derive_spend_r(&self.env, &state.vk, &sigma);
        let c_spend_new = commit(&self.env, v_new, &r_new);
        let b_tilde = encrypt_balance(&self.env, v_new, &state.vk, &sigma);
        let auditor_pub = point_mul_big(&self.env, &h_point(&self.env), &BigUint::from(55u32));
        let (mask0, mask1) =
            sponge_squeeze_2(&self.env, DOMAIN_AUDITOR_SENDER, &ecdh_x(&self.env, &auditor_pub, &r_e), &sigma);
        let v_aud_s = field_add_u128(&mask0, delegation.value);
        let b_aud_s = field_add_u128(&mask1, v_new);
        let r_e_point = point_mul_big(&self.env, &h_point(&self.env), &r_e);

        self.run_revoke_spender_proof(
            owner,
            spender,
            token,
            &delegation,
            &sigma,
            &r_e,
            &auditor_pub,
            &c_spend_new,
            &b_tilde,
            &r_e_point,
            &v_aud_s,
            &b_aud_s,
        )?;

        let payload = RevokeSpenderData {
            payload: RevokeSpenderPayload {
                c_spend_new: c_spend_new.clone(),
                b_tilde: field_to_bytesn(&self.env, &b_tilde),
                r_e: r_e_point,
                sigma: field_to_bytesn(&self.env, &sigma),
                v_aud_s: field_to_bytesn(&self.env, &v_aud_s),
                b_aud_s: field_to_bytesn(&self.env, &b_aud_s),
            },
            proof: Bytes::from_slice(
                &self.env,
                &fs::read(self.state_dir.join("proof-revoke-spender").join("proof"))?,
            ),
        };
        let data = payload.to_xdr(&self.env);
        let file = write_temp_file(data.to_alloc_vec().as_slice())?;

        self.run_stellar_owned(
            vec![
                "contract".to_string(),
                "invoke".to_string(),
                "--id".to_string(),
                token.confidential_token.clone(),
                "--source-account".to_string(),
                owner_name,
                "-n".to_string(),
                NETWORK_NAME.to_string(),
                "--".to_string(),
                "revoke_spender".to_string(),
                "--account".to_string(),
                owner_addr.to_string(),
                "--spender".to_string(),
                spender.stellar_address.clone(),
                "--data-file-path".to_string(),
                file.path().to_string_lossy().to_string(),
            ],
            true,
        )?;

        let state = owner.account_mut(token);
        state.spendable_value = v_new;
        state.spendable_r = r_new;
        state.spendable_balance = c_spend_new;
        state.delegations.remove(&spender.stellar_address);
        Ok(())
    }

    fn set_policy_blocked(
        &self,
        policy: &str,
        account: &str,
        blocked: bool,
        admin_addr: &str,
    ) -> Result<()> {
        self.run_stellar_owned(
            vec![
                "contract".to_string(),
                "invoke".to_string(),
                "--id".to_string(),
                policy.to_string(),
                "--source-account".to_string(),
                "admin".to_string(),
                "-n".to_string(),
                NETWORK_NAME.to_string(),
                "--".to_string(),
                "set_blocked".to_string(),
                "--account".to_string(),
                account.to_string(),
                "--blocked".to_string(),
                blocked.to_string(),
                "--operator".to_string(),
                admin_addr.to_string(),
            ],
            true,
        )?;
        Ok(())
    }

    fn view_confidential_balance(&self, token: &str, account: &str) -> Result<String> {
        self.run_stellar_owned(
            vec![
                "contract".to_string(),
                "invoke".to_string(),
                "--id".to_string(),
                token.to_string(),
                "--source-account".to_string(),
                "admin".to_string(),
                "-n".to_string(),
                NETWORK_NAME.to_string(),
                "--send".to_string(),
                "no".to_string(),
                "--".to_string(),
                "confidential_balance_xdr".to_string(),
                "--account".to_string(),
                account.to_string(),
            ],
            true,
        )
    }

    fn view_spender_delegation(&self, token: &str, account: &str, spender: &str) -> Result<String> {
        self.run_stellar_owned(
            vec![
                "contract".to_string(),
                "invoke".to_string(),
                "--id".to_string(),
                token.to_string(),
                "--source-account".to_string(),
                "admin".to_string(),
                "-n".to_string(),
                NETWORK_NAME.to_string(),
                "--send".to_string(),
                "no".to_string(),
                "--".to_string(),
                "spender_delegation_xdr".to_string(),
                "--account".to_string(),
                account.to_string(),
                "--spender".to_string(),
                spender.to_string(),
            ],
            true,
        )
    }

    fn is_spender(&self, token: &str, account: &str, spender: &str) -> Result<String> {
        self.run_stellar_owned(
            vec![
                "contract".to_string(),
                "invoke".to_string(),
                "--id".to_string(),
                token.to_string(),
                "--source-account".to_string(),
                "admin".to_string(),
                "-n".to_string(),
                NETWORK_NAME.to_string(),
                "--send".to_string(),
                "no".to_string(),
                "--".to_string(),
                "is_spender".to_string(),
                "--account".to_string(),
                account.to_string(),
                "--spender".to_string(),
                spender.to_string(),
            ],
            true,
        )
    }

    fn fetch_contract_events(&self, contract_id: &str) -> Result<Value> {
        let start_ledger = self.current_ledger()?.saturating_sub(200).max(1);
        let stdout = self.run_stellar_owned(
            vec![
                "events".to_string(),
                "--start-ledger".to_string(),
                start_ledger.to_string(),
                "--id".to_string(),
                contract_id.to_string(),
                "--output".to_string(),
                "json".to_string(),
                "--count".to_string(),
                "200".to_string(),
                "-n".to_string(),
                NETWORK_NAME.to_string(),
            ],
            true,
        )?;
        let events = stdout
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(serde_json::from_str::<Value>)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Value::Array(events))
    }

    fn current_ledger(&self) -> Result<u32> {
        self.current_ledger_on(NETWORK_NAME)
    }

    fn current_ledger_on(&self, network: &str) -> Result<u32> {
        let stdout = self.run_stellar_owned(
            vec![
                "ledger".to_string(),
                "latest".to_string(),
                "-n".to_string(),
                network.to_string(),
            ],
            true,
        )?;
        let sequence_line = stdout
            .lines()
            .find(|line| line.trim_start().starts_with("Sequence:"))
            .ok_or_else(|| anyhow!("missing Sequence line in `stellar ledger latest` output"))?;
        let sequence = sequence_line
            .split_once(':')
            .map(|(_, value)| value.trim())
            .ok_or_else(|| anyhow!("malformed Sequence line in `stellar ledger latest` output"))?
            .parse::<u32>()
            .context("failed to parse latest ledger sequence")?;
        Ok(sequence)
    }

    fn run_register_proof(
        &self,
        sk: &BigUint,
        y: &Point,
        state: &AccountState,
        addr_f: &BigUint,
        out_dir: &Path,
    ) -> Result<()> {
        self.write_prover_file(
            "register",
            &[
                ("sk", sk),
                ("y_x", &point_x(&self.env, y)),
                ("y_y", &point_y(&self.env, y)),
                ("pvk_x", &point_x(&self.env, &state.pvk)),
                ("pvk_y", &point_y(&self.env, &state.pvk)),
                ("addr_f", addr_f),
            ],
        )?;
        self.generate_proof("circuit_register", out_dir)
    }

    #[allow(clippy::too_many_arguments)]
    fn run_transfer_proof(
        &self,
        from: &Actor,
        recipient: &AccountState,
        token: &TokenContext,
        amount: u128,
        sigma: &BigUint,
        r_e: &BigUint,
        auditor_pub: &Point,
        c_spend_new: &Point,
        c_tx: &Point,
        r_e_point: &Point,
        v_tilde: &BigUint,
        b_tilde: &BigUint,
        v_aud_r: &BigUint,
        r_aud_r: &BigUint,
        v_aud_s: &BigUint,
        b_aud_s: &BigUint,
    ) -> Result<()> {
        let state = from.account(token);
        self.write_prover_file(
            "transfer",
            &[
                ("sk", &from.sk),
                ("v", &BigUint::from(state.spendable_value)),
                ("r", &state.spendable_r),
                ("v_tx", &BigUint::from(amount)),
                ("r_e", r_e),
                ("c_spend_x", &point_x(&self.env, &state.spendable_balance)),
                ("c_spend_y", &point_y(&self.env, &state.spendable_balance)),
                ("y_x", &point_x(&self.env, &from.y)),
                ("y_y", &point_y(&self.env, &from.y)),
                ("pvk_b_x", &point_x(&self.env, &recipient.pvk)),
                ("pvk_b_y", &point_y(&self.env, &recipient.pvk)),
                ("addr_f", &token.addr_f),
                ("k_aud_r_x", &point_x(&self.env, auditor_pub)),
                ("k_aud_r_y", &point_y(&self.env, auditor_pub)),
                ("k_aud_s_x", &point_x(&self.env, auditor_pub)),
                ("k_aud_s_y", &point_y(&self.env, auditor_pub)),
                ("c_spend_new_x", &point_x(&self.env, c_spend_new)),
                ("c_spend_new_y", &point_y(&self.env, c_spend_new)),
                ("c_tx_x", &point_x(&self.env, c_tx)),
                ("c_tx_y", &point_y(&self.env, c_tx)),
                ("r_e_x", &point_x(&self.env, r_e_point)),
                ("r_e_y", &point_y(&self.env, r_e_point)),
                ("v_tilde", v_tilde),
                ("b_tilde", b_tilde),
                ("sigma", sigma),
                ("v_tilde_aud_r", v_aud_r),
                ("r_tilde_aud_r", r_aud_r),
                ("v_tilde_aud_s", v_aud_s),
                ("b_tilde_aud_s", b_aud_s),
            ],
        )?;
        self.generate_proof("circuit_transfer", &self.state_dir.join("proof-transfer"))
    }

    #[allow(clippy::too_many_arguments)]
    fn run_set_spender_proof(
        &self,
        owner: &Actor,
        spender: &Actor,
        token: &TokenContext,
        amount: u128,
        sigma: &BigUint,
        sigma_a: &BigUint,
        r_e: &BigUint,
        auditor_pub: &Point,
        c_spend_new: &Point,
        c_a: &Point,
        escrowed_dvk: &Point,
        b_tilde: &BigUint,
        a_tilde: &BigUint,
        r_e_point: &Point,
        v_aud_s: &BigUint,
        b_aud_s: &BigUint,
    ) -> Result<()> {
        let state = owner.account(token);
        self.write_prover_file(
            "set_spender",
            &[
                ("sk", &owner.sk),
                ("v", &BigUint::from(state.spendable_value)),
                ("r", &state.spendable_r),
                ("v_a", &BigUint::from(amount)),
                ("r_e", r_e),
                ("c_spend_x", &point_x(&self.env, &state.spendable_balance)),
                ("c_spend_y", &point_y(&self.env, &state.spendable_balance)),
                ("y_x", &point_x(&self.env, &owner.y)),
                ("y_y", &point_y(&self.env, &owner.y)),
                ("y_op_x", &point_x(&self.env, &spender.y)),
                ("y_op_y", &point_y(&self.env, &spender.y)),
                ("op_i", &address_to_field(&self.env, &spender.stellar_address)),
                ("addr_f", &token.addr_f),
                ("k_aud_s_x", &point_x(&self.env, auditor_pub)),
                ("k_aud_s_y", &point_y(&self.env, auditor_pub)),
                ("c_spend_new_x", &point_x(&self.env, c_spend_new)),
                ("c_spend_new_y", &point_y(&self.env, c_spend_new)),
                ("c_a_x", &point_x(&self.env, c_a)),
                ("c_a_y", &point_y(&self.env, c_a)),
                ("escrowed_dvk_r_x", &point_x(&self.env, escrowed_dvk)),
                ("escrowed_dvk_cipher", &point_y(&self.env, escrowed_dvk)),
                ("b_tilde", b_tilde),
                ("a_tilde", a_tilde),
                ("sigma", sigma),
                ("sigma_a", sigma_a),
                ("r_e_x", &point_x(&self.env, r_e_point)),
                ("r_e_y", &point_y(&self.env, r_e_point)),
                ("v_tilde_aud_s", v_aud_s),
                ("b_tilde_aud_s", b_aud_s),
            ],
        )?;
        self.generate_proof("circuit_set_spender", &self.state_dir.join("proof-set-spender"))
    }

    #[allow(clippy::too_many_arguments)]
    fn run_spender_transfer_proof(
        &self,
        _owner: &Actor,
        spender: &Actor,
        recipient: &Actor,
        token: &TokenContext,
        delegation: &DelegationState,
        amount: u128,
        sigma_a_new: &BigUint,
        r_e: &BigUint,
        auditor_pub: &Point,
        c_a_new: &Point,
        c_tx: &Point,
        r_e_point: &Point,
        v_aud_r: &BigUint,
        r_aud_r: &BigUint,
        v_aud_s: &BigUint,
        a_aud_s: &BigUint,
        a_tilde_new: &BigUint,
    ) -> Result<()> {
        let recipient_state = recipient.account(token);
        self.write_prover_file(
            "spender_transfer",
            &[
                ("sk_op", &spender.sk),
                ("dvk_i", &delegation.dvk),
                ("v_a", &BigUint::from(delegation.value)),
                ("r_a", &delegation.randomness),
                ("v_tx", &BigUint::from(amount)),
                ("r_e", r_e),
                ("c_a_x", &point_x(&self.env, &delegation.commitment)),
                ("c_a_y", &point_y(&self.env, &delegation.commitment)),
                ("sigma_a", &delegation.sigma_a),
                ("y_op_x", &point_x(&self.env, &spender.y)),
                ("y_op_y", &point_y(&self.env, &spender.y)),
                ("pvk_recipient_x", &point_x(&self.env, &recipient_state.pvk)),
                ("pvk_recipient_y", &point_y(&self.env, &recipient_state.pvk)),
                ("k_aud_r_x", &point_x(&self.env, auditor_pub)),
                ("k_aud_r_y", &point_y(&self.env, auditor_pub)),
                ("k_aud_s_x", &point_x(&self.env, auditor_pub)),
                ("k_aud_s_y", &point_y(&self.env, auditor_pub)),
                ("c_a_new_x", &point_x(&self.env, c_a_new)),
                ("c_a_new_y", &point_y(&self.env, c_a_new)),
                ("c_tx_x", &point_x(&self.env, c_tx)),
                ("c_tx_y", &point_y(&self.env, c_tx)),
                ("r_e_x", &point_x(&self.env, r_e_point)),
                ("r_e_y", &point_y(&self.env, r_e_point)),
                (
                    "v_tilde",
                    &encrypt_amount(
                        &self.env,
                        amount,
                        &ecdh_x(&self.env, &recipient_state.pvk, r_e),
                        &delegation.sigma_a,
                    ),
                ),
                ("a_tilde_new", a_tilde_new),
                ("sigma_a_new", sigma_a_new),
                ("v_tilde_aud_r", v_aud_r),
                ("r_tilde_aud_r", r_aud_r),
                ("v_tilde_aud_s", v_aud_s),
                ("a_tilde_aud_s", a_aud_s),
            ],
        )?;
        self.generate_proof("circuit_spender_transfer", &self.state_dir.join("proof-spender-transfer"))
    }

    #[allow(clippy::too_many_arguments)]
    fn run_revoke_spender_proof(
        &self,
        owner: &Actor,
        spender: &Actor,
        token: &TokenContext,
        delegation: &DelegationState,
        sigma: &BigUint,
        r_e: &BigUint,
        auditor_pub: &Point,
        c_spend_new: &Point,
        b_tilde: &BigUint,
        r_e_point: &Point,
        v_aud_s: &BigUint,
        b_aud_s: &BigUint,
    ) -> Result<()> {
        let state = owner.account(token);
        self.write_prover_file(
            "revoke_spender",
            &[
                ("sk", &owner.sk),
                ("v_a", &BigUint::from(delegation.value)),
                ("r_a", &delegation.randomness),
                ("v_s", &BigUint::from(state.spendable_value)),
                ("r_s", &state.spendable_r),
                ("r_e", r_e),
                ("c_spend_x", &point_x(&self.env, &state.spendable_balance)),
                ("c_spend_y", &point_y(&self.env, &state.spendable_balance)),
                ("c_a_x", &point_x(&self.env, &delegation.commitment)),
                ("c_a_y", &point_y(&self.env, &delegation.commitment)),
                ("sigma_a", &delegation.sigma_a),
                ("y_x", &point_x(&self.env, &owner.y)),
                ("y_y", &point_y(&self.env, &owner.y)),
                ("op_i", &address_to_field(&self.env, &spender.stellar_address)),
                ("addr_f", &token.addr_f),
                ("k_aud_s_x", &point_x(&self.env, auditor_pub)),
                ("k_aud_s_y", &point_y(&self.env, auditor_pub)),
                ("c_spend_new_x", &point_x(&self.env, c_spend_new)),
                ("c_spend_new_y", &point_y(&self.env, c_spend_new)),
                ("b_tilde", b_tilde),
                ("sigma", sigma),
                ("r_e_x", &point_x(&self.env, r_e_point)),
                ("r_e_y", &point_y(&self.env, r_e_point)),
                ("v_tilde_aud_s", v_aud_s),
                ("b_tilde_aud_s", b_aud_s),
            ],
        )?;
        self.generate_proof("circuit_revoke_spender", &self.state_dir.join("proof-revoke-spender"))
    }

    #[allow(clippy::too_many_arguments)]
    fn run_collateral_sufficiency_proof(
        &self,
        collateral_amount: u128,
        collateral_randomness: &BigUint,
        credit_amount: u128,
        credit_randomness: &BigUint,
        position_secret: &BigUint,
        lock_key: &BigUint,
        oracle_price_e7: u128,
        haircut_bps: u32,
        tenor_days: u32,
        out_dir: &Path,
    ) -> Result<CollateralProofArtifacts> {
        let collateral_commitment = commit(&self.env, collateral_amount, collateral_randomness);
        let credit_commitment = commit(&self.env, credit_amount, credit_randomness);
        let position_nullifier = poseidon_with_domain_any(
            &self.env,
            30,
            &[
                position_secret.clone(),
                point_x(&self.env, &collateral_commitment),
                point_y(&self.env, &collateral_commitment),
                point_x(&self.env, &credit_commitment),
                point_y(&self.env, &credit_commitment),
                lock_key.clone(),
                BigUint::from(tenor_days),
            ],
        );

        self.write_prover_file(
            "collateral_sufficiency",
            &[
                ("collateral_amount", &BigUint::from(collateral_amount)),
                ("collateral_randomness", collateral_randomness),
                ("credit_amount", &BigUint::from(credit_amount)),
                ("credit_randomness", credit_randomness),
                ("position_secret", position_secret),
                ("collateral_commitment_x", &point_x(&self.env, &collateral_commitment)),
                ("collateral_commitment_y", &point_y(&self.env, &collateral_commitment)),
                ("credit_commitment_x", &point_x(&self.env, &credit_commitment)),
                ("credit_commitment_y", &point_y(&self.env, &credit_commitment)),
                ("oracle_price_e7", &BigUint::from(oracle_price_e7)),
                ("haircut_bps", &BigUint::from(haircut_bps)),
                ("tenor_days", &BigUint::from(tenor_days)),
                ("lock_key", lock_key),
                ("position_nullifier", &position_nullifier),
            ],
        )?;
        self.generate_vk("circuit_collateral_sufficiency", out_dir)?;
        self.generate_proof("circuit_collateral_sufficiency", out_dir)?;

        Ok(CollateralProofArtifacts {
            collateral_commitment,
            credit_commitment,
            lock_key: lock_key.clone(),
            position_nullifier,
            oracle_price_e7,
            haircut_bps,
            tenor_days,
            public_inputs: fs::read(out_dir.join("public_inputs"))?,
            proof: fs::read(out_dir.join("proof"))?,
        })
    }

    fn run_wrong_randomness_collateral_proof(
        &self,
        valid: &CollateralProofArtifacts,
    ) -> Result<()> {
        let out_dir = self.state_dir.join("proof-collateral-sufficiency-wrong-randomness");
        self.write_prover_file(
            "collateral_sufficiency",
            &[
                ("collateral_amount", &BigUint::from(2_000u32)),
                ("collateral_randomness", &BigUint::from(999u32)),
                ("credit_amount", &BigUint::from(1_000u32)),
                ("credit_randomness", &BigUint::from(202u32)),
                ("position_secret", &BigUint::from(303u32)),
                ("collateral_commitment_x", &point_x(&self.env, &valid.collateral_commitment)),
                ("collateral_commitment_y", &point_y(&self.env, &valid.collateral_commitment)),
                ("credit_commitment_x", &point_x(&self.env, &valid.credit_commitment)),
                ("credit_commitment_y", &point_y(&self.env, &valid.credit_commitment)),
                ("oracle_price_e7", &BigUint::from(valid.oracle_price_e7)),
                ("haircut_bps", &BigUint::from(valid.haircut_bps)),
                ("tenor_days", &BigUint::from(valid.tenor_days)),
                ("lock_key", &valid.lock_key),
                ("position_nullifier", &valid.position_nullifier),
            ],
        )?;
        self.generate_proof("circuit_collateral_sufficiency", &out_dir)?;
        Ok(())
    }

    fn write_prover_file(&self, package_dir: &str, fields: &[(&str, &BigUint)]) -> Result<()> {
        let mut content = String::new();
        for (name, value) in fields {
            content.push_str(name);
            content.push_str(" = \"");
            content.push_str(&value.to_str_radix(10));
            content.push_str("\"\n");
        }
        fs::write(self.circuits_dir.join(package_dir).join("Prover.toml"), content)?;
        Ok(())
    }

    fn generate_proof(&self, package: &str, out_dir: &Path) -> Result<()> {
        fs::create_dir_all(out_dir)?;
        self.run_command(
            "nargo",
            ["compile", "--package", package],
            Some(&self.circuits_dir),
        )?;
        self.run_command(
            "nargo",
            ["execute", "--package", package],
            Some(&self.circuits_dir),
        )?;
        let acir = self.circuits_dir.join("target").join(format!("{package}.json"));
        let witness = self.circuits_dir.join("target").join(format!("{package}.gz"));
        self.run_command(
            "bb",
            [
                "prove",
                "--scheme",
                "ultra_honk",
                "--oracle_hash",
                "keccak",
                "--bytecode_path",
                acir.to_str().unwrap(),
                "--witness_path",
                witness.to_str().unwrap(),
                "--output_path",
                out_dir.to_str().unwrap(),
                "--output_format",
                "bytes_and_fields",
            ],
            Some(&self.circuits_dir),
        )?;
        Ok(())
    }

    fn generate_vk(&self, package: &str, out_dir: &Path) -> Result<()> {
        fs::create_dir_all(out_dir)?;
        self.run_command(
            "nargo",
            ["compile", "--package", package],
            Some(&self.circuits_dir),
        )?;
        let acir = self.circuits_dir.join("target").join(format!("{package}.json"));
        self.run_command(
            "bb",
            [
                "write_vk",
                "--scheme",
                "ultra_honk",
                "--oracle_hash",
                "keccak",
                "--bytecode_path",
                acir.to_str().unwrap(),
                "--output_path",
                out_dir.to_str().unwrap(),
                "--output_format",
                "bytes_and_fields",
            ],
            Some(&self.circuits_dir),
        )?;
        Ok(())
    }

    fn wasm_path(&self, package: &str) -> PathBuf {
        self.wasm_dir.join(format!("{}.wasm", package.replace('-', "_")))
    }

    fn run_stellar<I, S>(&self, args: I, check: bool) -> Result<String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.run_stellar_owned(args.into_iter().map(|arg| arg.as_ref().to_string()).collect(), check)
    }

    fn run_stellar_owned(&self, mut args: Vec<String>, check: bool) -> Result<String> {
        let mut all_args = vec!["--config-dir".to_string(), self.config_dir.to_string_lossy().to_string()];
        all_args.append(&mut args);
        self.run_command_owned("stellar", all_args, Some(&self.root), check)
    }

    fn run_command<I, S>(&self, program: &str, args: I, cwd: Option<&Path>) -> Result<String>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.run_command_owned(
            program,
            args.into_iter().map(|arg| arg.as_ref().to_string()).collect(),
            cwd,
            true,
        )
    }

    fn run_command_owned(
        &self,
        program: &str,
        args: Vec<String>,
        cwd: Option<&Path>,
        check: bool,
    ) -> Result<String> {
        let mut cmd = Command::new(program);
        cmd.args(&args);
        let path = env::var("PATH").unwrap_or_default();
        let home = env::var("HOME").unwrap_or_default();
        let tool_paths = if home.is_empty() {
            format!("{}:{}", self.root.join("scripts/bin").display(), path)
        } else {
            format!(
                "{}:{}/.nargo/bin:{}/.bb:{}",
                self.root.join("scripts/bin").display(),
                home,
                home,
                path
            )
        };
        cmd.env("PATH", tool_paths);
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        let output = cmd.output().with_context(|| format!("failed to run {program}"))?;
        output_string(program, &args, output, check)
    }
}

struct TransferArtifacts {
    amount: u128,
    sigma: BigUint,
    r_e_point: Point,
    v_aud_r: BigUint,
    r_aud_r: BigUint,
    v_aud_s: BigUint,
    b_aud_s: BigUint,
}

impl TransferArtifacts {
    fn event_snapshot(&self) -> Value {
        json!({
            "r_e": hex::encode(point_to_bytes(&self.r_e_point)),
            "v_aud_r": self.v_aud_r.to_str_radix(16),
            "r_aud_r": self.r_aud_r.to_str_radix(16),
            "v_aud_s": self.v_aud_s.to_str_radix(16),
            "b_aud_s": self.b_aud_s.to_str_radix(16),
        })
    }

    fn decrypt_report(&self, env: &Env, _auditor_addr: &str) -> Value {
        let auditor_secret = BigUint::from(55u32);
        let shared = ecdh_x(env, &self.r_e_point, &auditor_secret);
        let (mask0, mask1) = sponge_squeeze_2(env, DOMAIN_AUDITOR_RECIPIENT, &shared, &self.sigma);
        let amount = field_sub(&self.v_aud_r, &mask0);
        let randomness = field_sub(&self.r_aud_r, &mask1);
        json!({
            "decrypted_amount": amount.to_string(),
            "expected_amount": self.amount.to_string(),
            "amount_matches": amount == BigUint::from(self.amount),
            "decrypted_randomness_hex": randomness.to_str_radix(16),
        })
    }
}

impl Actor {
    fn account<'a>(&'a self, token: &TokenContext) -> &'a AccountState {
        self.per_token
            .get(&token.confidential_token)
            .unwrap_or_else(|| panic!("missing account state for {}", token.name))
    }

    fn account_mut<'a>(&'a mut self, token: &TokenContext) -> &'a mut AccountState {
        self.per_token
            .get_mut(&token.confidential_token)
            .unwrap_or_else(|| panic!("missing mutable account state for {}", token.name))
    }
}

impl AccountState {
    fn apply_deposit(&mut self, env: &Env, amount: u128) {
        let deposit = point_mul_big(env, &Grumpkin::generator(env), &BigUint::from(amount));
        self.receiving_value += amount;
        self.receiving_balance = Grumpkin::add(env, &self.receiving_balance, &deposit);
    }

    fn merge(&mut self, env: &Env) {
        self.spendable_value += self.receiving_value;
        self.spendable_r = field_add(&self.spendable_r, &self.receiving_r);
        self.spendable_balance = Grumpkin::add(env, &self.spendable_balance, &self.receiving_balance);
        self.receiving_value = 0;
        self.receiving_r = BigUint::zero();
        self.receiving_balance = Grumpkin::identity(env);
    }
}

fn build_zeroed_account_state(env: &Env, sk: &BigUint, addr_f: &BigUint) -> AccountState {
    let vk = vk_from_sk(env, sk, addr_f);
    let pvk = point_mul_big(env, &h_point(env), &vk);
    AccountState {
        vk,
        pvk,
        spendable_value: 0,
        spendable_r: BigUint::zero(),
        spendable_balance: Grumpkin::identity(env),
        receiving_value: 0,
        receiving_r: BigUint::zero(),
        receiving_balance: Grumpkin::identity(env),
        delegations: BTreeMap::new(),
    }
}

fn state_to_y(actor: &Actor) -> Point {
    actor.y.clone()
}

fn h_point(env: &Env) -> Point {
    let bytes = hex::decode(H_HEX).expect("valid H bytes");
    let mut arr = [0u8; 64];
    arr.copy_from_slice(&bytes);
    BytesN::from_array(env, &arr)
}

fn modulus() -> BigUint {
    BigUint::parse_bytes(BN254_FR_MODULUS_HEX.as_bytes(), 16).expect("valid modulus")
}

fn field_add(a: &BigUint, b: &BigUint) -> BigUint {
    let m = modulus();
    (a + b) % m
}

fn field_add_u128(a: &BigUint, b: u128) -> BigUint {
    field_add(a, &BigUint::from(b))
}

fn field_sub(a: &BigUint, b: &BigUint) -> BigUint {
    let m = modulus();
    if a >= b {
        a - b
    } else {
        (&m - (b - a)) % m
    }
}

fn field_to_bytes32(v: &BigUint) -> [u8; 32] {
    let mut out = [0u8; 32];
    let bytes = v.to_bytes_be();
    let start = 32 - bytes.len();
    out[start..].copy_from_slice(&bytes);
    out
}

fn field_to_hex(v: &BigUint) -> String {
    hex::encode(field_to_bytes32(v))
}

fn field_bytes_from_u128(value: u128) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[16..].copy_from_slice(&value.to_be_bytes());
    out
}

fn replace_public_input_u128(inputs: &[u8], index: usize, value: u128) -> Vec<u8> {
    let mut out = inputs.to_vec();
    let start = index * 32;
    let end = start + 32;
    out[start..end].copy_from_slice(&field_bytes_from_u128(value));
    out
}

fn field_to_u256(env: &Env, v: &BigUint) -> U256 {
    U256::from_be_bytes(env, &Bytes::from_array(env, &field_to_bytes32(v)))
}

fn field_to_bytesn(env: &Env, v: &BigUint) -> BytesN<32> {
    BytesN::from_array(env, &field_to_bytes32(v))
}

fn bytesn_to_big(bytes: &BytesN<32>) -> BigUint {
    BigUint::from_bytes_be(&bytes.to_array())
}

fn point_to_bytes(point: &Point) -> [u8; 64] {
    point.to_array()
}

fn point_x(env: &Env, point: &Point) -> BigUint {
    let (x, _) = Grumpkin::coordinates(env, point);
    bytesn_to_big(&x.to_bytes())
}

fn point_y(env: &Env, point: &Point) -> BigUint {
    let (_, y) = Grumpkin::coordinates(env, point);
    bytesn_to_big(&y.to_bytes())
}

fn encode_noncurve_pair(env: &Env, x: &BigUint, y: &BigUint) -> Point {
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&field_to_bytes32(x));
    out[32..].copy_from_slice(&field_to_bytes32(y));
    BytesN::from_array(env, &out)
}

fn point_mul_big(env: &Env, point: &Point, scalar: &BigUint) -> Point {
    if scalar.is_zero() || Grumpkin::is_identity(point) {
        return Grumpkin::identity(env);
    }
    let mut k = scalar.clone();
    let mut result = Grumpkin::identity(env);
    let mut base = point.clone();
    while !k.is_zero() {
        if (&k & BigUint::one()) == BigUint::one() {
            result = Grumpkin::add(env, &result, &base);
        }
        k >>= 1usize;
        if !k.is_zero() {
            base = Grumpkin::add(env, &base, &base);
        }
    }
    result
}

fn commit(env: &Env, value: u128, randomness: &BigUint) -> Point {
    let g = Grumpkin::generator(env);
    let value_commit = point_mul_big(env, &g, &BigUint::from(value));
    let blind_commit = point_mul_big(env, &h_point(env), randomness);
    Grumpkin::add(env, &value_commit, &blind_commit)
}

fn ecdh_x(env: &Env, point: &Point, scalar: &BigUint) -> BigUint {
    point_x(env, &point_mul_big(env, point, scalar))
}

fn poseidon2_hash_any(env: &Env, inputs: &[BigUint]) -> BigUint {
    let values = to_u256_vec(env, inputs);
    let out = match inputs.len() {
        1 => poseidon2_hash::<2, Bn254Fr>(env, &values),
        2 => poseidon2_hash::<3, Bn254Fr>(env, &values),
        3 => poseidon2_hash::<4, Bn254Fr>(env, &values),
        4 => poseidon2_hash::<4, Bn254Fr>(env, &values),
        _ => panic!("unsupported input count {}", inputs.len()),
    };
    BigUint::from_bytes_be(&out.to_be_bytes().to_alloc_vec())
}

fn poseidon_with_domain(env: &Env, domain: u32, inputs: &[BigUint]) -> BigUint {
    let mut all = Vec::with_capacity(inputs.len() + 1);
    all.push(BigUint::from(domain));
    all.extend_from_slice(inputs);
    poseidon2_hash_any(env, &all)
}

fn poseidon_with_domain_any(env: &Env, domain: u32, inputs: &[BigUint]) -> BigUint {
    let mut all = Vec::with_capacity(inputs.len() + 1);
    all.push(BigUint::from(domain));
    all.extend_from_slice(inputs);
    poseidon2_sponge(env, &all)
}

fn poseidon2_sponge(env: &Env, inputs: &[BigUint]) -> BigUint {
    let iv = BigUint::from(inputs.len()) * BigUint::from(POSEIDON2_IV_BASE);
    let mut state = [
        BigUint::zero(),
        BigUint::zero(),
        BigUint::zero(),
        iv,
    ];
    let m_diag = <Poseidon2Sponge<4, Bn254Fr> as Poseidon2Config<4, Bn254Fr>>::get_m_diag(env);
    let rc = <Poseidon2Sponge<4, Bn254Fr> as Poseidon2Config<4, Bn254Fr>>::get_rc(env);

    for chunk in inputs.chunks(3) {
        for (idx, input) in chunk.iter().enumerate() {
            state[idx] = field_add(&state[idx], input);
        }
        let state_vec = soroban_sdk::vec![
            env,
            field_to_u256(env, &state[0]),
            field_to_u256(env, &state[1]),
            field_to_u256(env, &state[2]),
            field_to_u256(env, &state[3]),
        ];
        let out = env.crypto_hazmat().poseidon2_permutation(
            &state_vec,
            Bn254Fr::symbol(),
            4,
            SBOX_D,
            8,
            56,
            &m_diag,
            &rc,
        );
        for idx in 0..4 {
            state[idx] = BigUint::from_bytes_be(
                &out.get_unchecked(idx as u32).to_be_bytes().to_alloc_vec(),
            );
        }
    }
    state[0].clone()
}

fn vk_from_sk(env: &Env, sk: &BigUint, addr_f: &BigUint) -> BigUint {
    poseidon_with_domain(env, DOMAIN_VIEWING_KEY, &[sk.clone(), addr_f.clone()])
}

fn dvk_from_vk_op(env: &Env, vk: &BigUint, op_i: &BigUint) -> BigUint {
    poseidon_with_domain(env, DOMAIN_DELEGATION_VIEWING_KEY, &[vk.clone(), op_i.clone()])
}

fn derive_spend_r(env: &Env, vk: &BigUint, sigma: &BigUint) -> BigUint {
    poseidon_with_domain(env, DOMAIN_SPEND_RANDOMNESS, &[vk.clone(), sigma.clone()])
}

fn derive_allow_r(env: &Env, dvk: &BigUint, sigma_a: &BigUint) -> BigUint {
    poseidon_with_domain(env, DOMAIN_ALLOWANCE_RANDOMNESS, &[dvk.clone(), sigma_a.clone()])
}

fn derive_tx_blind(env: &Env, s: &BigUint, sigma: &BigUint) -> BigUint {
    poseidon_with_domain(env, DOMAIN_TX_BLINDING, &[s.clone(), sigma.clone()])
}

fn encrypt_amount(env: &Env, amount: u128, s: &BigUint, sigma: &BigUint) -> BigUint {
    field_add_u128(&poseidon_with_domain(env, DOMAIN_TX_AMOUNT, &[s.clone(), sigma.clone()]), amount)
}

fn encrypt_balance(env: &Env, value: u128, vk: &BigUint, sigma: &BigUint) -> BigUint {
    field_add_u128(
        &poseidon_with_domain(env, DOMAIN_ENCRYPTED_BALANCE, &[vk.clone(), sigma.clone()]),
        value,
    )
}

fn encrypt_allowance(env: &Env, value: u128, dvk: &BigUint, sigma_a: &BigUint) -> BigUint {
    field_add_u128(
        &poseidon_with_domain(env, DOMAIN_ENCRYPTED_ALLOWANCE, &[dvk.clone(), sigma_a.clone()]),
        value,
    )
}

fn encrypt_escrowed_dvk(env: &Env, dvk: &BigUint, shared: &BigUint, op_i: &BigUint) -> BigUint {
    field_add(
        dvk,
        &poseidon_with_domain(env, DOMAIN_ESCROWED_DVK, &[shared.clone(), op_i.clone()]),
    )
}

fn address_to_field(env: &Env, address: &str) -> BigUint {
    let bytes = address.as_bytes();
    let lo = BigUint::from_bytes_le(&bytes[..28]);
    let hi = BigUint::from_bytes_le(&bytes[28..56]);
    poseidon2_hash_any(env, &[BigUint::from(1u32), lo, hi])
}

fn sponge_squeeze_2(env: &Env, domain: u32, s_x: &BigUint, sigma: &BigUint) -> (BigUint, BigUint) {
    let iv = BigUint::from(3u32) * BigUint::from(POSEIDON2_IV_BASE);
    let state = soroban_sdk::vec![
        env,
        field_to_u256(env, &BigUint::from(domain)),
        field_to_u256(env, s_x),
        field_to_u256(env, sigma),
        field_to_u256(env, &iv),
    ];
    let m_diag = <Poseidon2Sponge<4, Bn254Fr> as Poseidon2Config<4, Bn254Fr>>::get_m_diag(env);
    let rc = <Poseidon2Sponge<4, Bn254Fr> as Poseidon2Config<4, Bn254Fr>>::get_rc(env);
    let out = env.crypto_hazmat().poseidon2_permutation(
        &state,
        Bn254Fr::symbol(),
        4,
        SBOX_D,
        8,
        56,
        &m_diag,
        &rc,
    );
    (
        BigUint::from_bytes_be(&out.get_unchecked(0).to_be_bytes().to_alloc_vec()),
        BigUint::from_bytes_be(&out.get_unchecked(1).to_be_bytes().to_alloc_vec()),
    )
}

fn to_u256_vec(env: &Env, inputs: &[BigUint]) -> soroban_sdk::Vec<U256> {
    let mut out = soroban_sdk::vec![env];
    for input in inputs {
        out.push_back(field_to_u256(env, input));
    }
    out
}

fn output_string(program: &str, args: &[String], output: Output, check: bool) -> Result<String> {
    if check && !output.status.success() {
        bail!(
            "{} {:?} failed with status {}: {}",
            program,
            args,
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }
    if !check && !output.status.success() {
        bail!("{}", String::from_utf8_lossy(&output.stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn write_temp_file(bytes: &[u8]) -> Result<NamedTempFile> {
    let mut file = NamedTempFile::new()?;
    std::io::Write::write_all(&mut file, bytes)?;
    Ok(file)
}

fn main() -> Result<()> {
    let cmd = env::args().nth(1).unwrap_or_default();
    let runner = Runner::new()?;
    match cmd.as_str() {
        "prove-of-life" => runner.run(),
        "phase3-local" => runner.run_phase3(NETWORK_NAME, true),
        "phase3-testnet" => runner.run_phase3(TESTNET_NAME, false),
        "phase4-local" => runner.run_phase4(NETWORK_NAME, true),
        "phase4-testnet" => runner.run_phase4(TESTNET_NAME, false),
        "phase6-local-deploy" => runner.run_phase6_deploy(NETWORK_NAME),
        "phase6-testnet-deploy" => runner.run_phase6_deploy(TESTNET_NAME),
        "collateral-fixture" => {
            let lock_key = env::args().nth(2).context("missing lock key hex")?;
            let position_secret = env::args().nth(3).context("missing position secret decimal")?;
            runner.print_collateral_fixture(&lock_key, &position_secret)
        }
        "repayment-history-fixture" => {
            let position_id = env::args().nth(2).context("missing position id hex")?;
            let proof_secret = env::args().nth(3).context("missing proof secret decimal")?;
            runner.print_repayment_history_fixture(&position_id, &proof_secret)
        }
        _ => {
            eprintln!(
                "usage: cargo run -p oz-confidential-runner -- <prove-of-life|phase3-local|phase3-testnet|phase4-local|phase4-testnet|phase6-local-deploy|phase6-testnet-deploy|collateral-fixture|repayment-history-fixture>"
            );
            std::process::exit(1);
        }
    }
}
