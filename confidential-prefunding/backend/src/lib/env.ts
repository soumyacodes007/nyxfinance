const required = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const optional = (name: string, fallbackName?: string): string | null => {
  const value = process.env[name] ?? (fallbackName ? process.env[fallbackName] : undefined);
  return value && value !== "REPLACE_ME" && !value.startsWith("TODO_") ? value : null;
};

const number = (name: string, fallback: number): number => Number(required(name, String(fallback)));
const flag = (name: string, fallback = false): boolean => {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
};

export const config = {
  apiPort: number("API_PORT", 3001),
  businessServerPort: number("BUSINESS_SERVER_PORT", 8091),
  frontendPort: number("FRONTEND_PORT", 3000),
  appStateDbPath: required("APP_STATE_DB_PATH", "./data/app.sqlite"),
  stellarRpcUrl: required("STELLAR_RPC_URL", "https://soroban-testnet.stellar.org"),
  stellarHorizonUrl: required("STELLAR_HORIZON_URL", "https://horizon-testnet.stellar.org"),
  stellarNetworkPassphrase: required(
    "STELLAR_NETWORK_PASSPHRASE",
    "Test SDF Network ; September 2015"
  ),
  friendbotUrl: required("STELLAR_FRIENDBOT_URL", "https://friendbot.stellar.org"),
  anchorPlatformUrl: required("ANCHOR_PLATFORM_URL", "http://anchor-platform:8080"),
  anchorPlatformPublicUrl: required("ANCHOR_PLATFORM_PUBLIC_URL", "http://localhost:8080"),
  anchorStellarTomlUrl: required(
    "ANCHOR_STELLAR_TOML_URL",
    "http://anchor-platform:8080/.well-known/stellar.toml"
  ),
  frontendApiBaseUrl: required("FRONTEND_API_BASE_URL", "http://api:3001"),
  prefundingFeeBps: number("PREFUNDING_FEE_BPS", 35),
  oracleMode: required("ORACLE_MODE", "mock"),
  oracleSource: required("ORACLE_SOURCE", "demo_adapter"),
  reflectorPulseContractId: optional("REFLECTOR_PULSE_CONTRACT_ID"),
  reflectorBaseAsset: required("REFLECTOR_BASE_ASSET", "USDC"),
  reflectorQuoteAsset: required("REFLECTOR_QUOTE_ASSET", "USDC"),
  reflectorStalenessSeconds: number("REFLECTOR_STALENESS_SECONDS", 900),
  watcherPollIntervalMs: number("WATCHER_POLL_INTERVAL_MS", 15000),
  proverPollIntervalMs: number("PROVER_POLL_INTERVAL_MS", 5000),
  proverMode: required("PROVER_MODE", "alpha_demo_prover_worker"),
  ozConfidentialRoot: required("OZ_CONFIDENTIAL_ROOT", "./oz-confidential"),
  hostSep10Account: required("HOST_SEP10_ACCOUNT", "REPLACE_ME"),
  distributionAccount: required("DISTRIBUTION_ACCOUNT", "REPLACE_ME"),
  demoAnchorAccount: required("DEMO_ANCHOR_ACCOUNT", "REPLACE_ME"),
  demoAnchorSecretKey: optional("DEMO_ANCHOR_SECRET_KEY"),
  demoAccounts: {
    alpha: optional("ALPHA_PUBLIC_KEY"),
    facility: optional("FACILITY_PUBLIC_KEY"),
    auditor: optional("AUDITOR_PUBLIC_KEY")
  },
  participantPolicyOperatorSecretKey: optional("PARTICIPANT_POLICY_OPERATOR_SECRET_KEY"),
  creditExecutorSecretKey: optional("CREDIT_EXECUTOR_SECRET_KEY"),
  requireConfidentialRepaymentTransfer: flag("REQUIRE_CONFIDENTIAL_REPAYMENT_TRANSFER", false),
  contracts: {
    participantPolicy: optional("PARTICIPANT_POLICY_CONTRACT_ID"),
    collateralPolicy: optional("COLLATERAL_POLICY_CONTRACT_ID"),
    oracleAdapter: optional("ORACLE_ADAPTER_CONTRACT_ID"),
    collateralLock: optional("COLLATERAL_LOCK_CONTRACT_ID"),
    prefundingCreditLine: optional("PREFUNDING_CREDIT_LINE_CONTRACT_ID"),
    collateralSufficiencyVerifier: optional("COLLATERAL_SUFFICIENCY_VERIFIER_CONTRACT_ID"),
    collateralToken: optional("COLLATERAL_TOKEN_CONTRACT_ID"),
    confidentialCusdc: optional("CONFIDENTIAL_CUSDC_CONTRACT_ID", "CUSDC_CONTRACT_ID"),
    disclosureGrantRegistry: optional(
      "DISCLOSURE_GRANT_REGISTRY_CONTRACT_ID",
      "DISCLOSURE_REGISTRY_CONTRACT_ID"
    ),
    repaymentHistory: optional("REPAYMENT_HISTORY_CONTRACT_ID"),
    repaymentHistoryVerifier: optional("REPAYMENT_HISTORY_VERIFIER_CONTRACT_ID")
  }
};

export type AppConfig = typeof config;
