import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import {
  getAnchorTransactionById,
  getLatestAnchorTransaction,
  getLatestQuote,
  getProofJob,
  getQuoteById,
  getSnapshot,
  listConfidentialTransferEvidence,
  upsertSnapshot
} from "../db/sqlite.js";
import type {
  CollateralSufficiencyProofPayload,
  CollateralSufficiencyProofResult,
  ProofJob,
  RepaymentHistoryProofPayload,
  RepaymentHistoryProofResult
} from "../types/proof.js";
import type { PrefundingQuote } from "../types/quote.js";
import { createCollateralSufficiencyJob, createRepaymentHistoryJob } from "./proof-jobs.js";
import { processNextProofJob } from "./prover-worker.js";
import { executeDraw, openCreditLine, repayCreditLine } from "./credit-line.js";
import { mergeConfidentialBalance } from "./confidential-token-transfer.js";
import { createSep31Transaction, markSep31Completed } from "./sep31.js";
import { putSep12Customer } from "./sep12.js";
import {
  seedRepaymentLeaf,
  setRepaymentHistoryRoot,
  verifyRepaymentHistory
} from "./repayment-history.js";

const SNAPSHOT_KEY = "demo_flow_state";
const REPAYMENT_COMMITMENT = "5555555555555555555555555555555555555555555555555555555555555555";

type CollateralFixture = CollateralSufficiencyProofPayload & {
  hex: {
    collateralCommitmentX: string;
    collateralCommitmentY: string;
    yX: string;
    yY: string;
    creditCommitmentX: string;
    creditCommitmentY: string;
    oraclePriceE7: string;
    haircutBps: string;
    tenorDays: string;
    lockKey: string;
    positionNullifier: string;
  };
};

type RepaymentHistoryFixture = {
  positionId: string;
  proofSecret: string;
  threshold: number;
  historyRoot: string;
  proofNullifier: string;
  publicInputsHex: string;
  leaves: Array<{
    repaymentAmount: string;
    paidLedger: number;
    dueLedger: number;
    leafSecret: string;
    leafNullifier: string;
    repaymentCommitment: string;
    onTime: boolean;
  }>;
  hex: {
    positionId: string;
    historyRoot: string;
    threshold: string;
    proofNullifier: string;
  };
};

type DemoFlowSnapshot = {
  profileId: string | null;
  anchorTransactionId: string | null;
  positionId: string | null;
  quote: PrefundingQuote | null;
  proof: {
    jobId: string;
    status: string;
    publicInputsHex: string | null;
    proofHex: string | null;
    verifierContractId: string | null;
  } | null;
  open: { txHash: string; ledger?: number | null } | null;
  draw: {
    txHash: string;
    ledger?: number | null;
    confidentialTransferTxHash: string | null;
    transferCommitment: string;
  } | null;
  repay: {
    txHash: string;
    ledger?: number | null;
    repaymentCommitment: string;
    confidentialTransferTxHash: string | null;
  } | null;
  historyProof: {
    jobId: string;
    status: string;
    verified: boolean;
    txHash: string;
    ledger?: number | null;
    proofNullifier: string;
    historyRoot: string;
    threshold: number;
    onTimeCount: number;
    leafCount: number;
    publicInputsHex: string;
    verifierContractId: string | null;
  } | null;
  updatedAt: string;
};

const nowIso = () => new Date().toISOString();

const blankState = (): DemoFlowSnapshot => ({
  profileId: null,
  anchorTransactionId: null,
  positionId: null,
  quote: null,
  proof: null,
  open: null,
  draw: null,
  repay: null,
  historyProof: null,
  updatedAt: nowIso()
});

const getStoredState = (db: AppDatabase): DemoFlowSnapshot => {
  const stored = getSnapshot<DemoFlowSnapshot>(db, SNAPSHOT_KEY);
  return stored ? { ...blankState(), ...stored.payload } : blankState();
};

const putStoredState = (db: AppDatabase, state: DemoFlowSnapshot): DemoFlowSnapshot => {
  const next = { ...state, updatedAt: nowIso() };
  upsertSnapshot(db, SNAPSHOT_KEY, next, "live");
  return next;
};

const configured = (value: string | null | undefined): value is string =>
  Boolean(value && value !== "REPLACE_ME" && !value.startsWith("TODO_"));

const demoSep31TransactionId = (): string =>
  process.env.DEMO_SEP31_TRANSACTION_ID ??
  process.env.NEXT_PUBLIC_DEMO_SEP31_TRANSACTION_ID ??
  "sep31-alpha-001";

const freshDemoSep31TransactionId = (profileId: string): string => {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `sep31-${profileId}-${stamp}`;
};

type DemoAnchorProfile = {
  id: string;
  account: string;
  signerSecretKey?: string;
  // F1/C1 v2: the anchor's confidential-token spending secret and the real
  // opening of its on-chain `spendable_balance` -- distinct from
  // `signerSecretKey` (the Stellar ed25519 key). Whoever runs this demo
  // prover must know both; there is no way to derive a hidden balance's
  // opening from chain state.
  confidentialSk?: string;
  collateralAmount?: string;
  collateralRandomness?: string;
  organizationName: string;
  emailAddress: string;
  drawTransferDataXdrBase64: string;
  drawAuditorPayload?: Record<string, unknown>;
  repaymentTransferDataXdrBase64: string;
  repaymentAuditorPayload?: Record<string, unknown>;
};

const normalizeProfileId = (profile?: string | null): string =>
  (profile ?? process.env.DEMO_ANCHOR_PROFILE ?? "alpha").trim().toLowerCase();

const profilePrefix = (profile: string): string =>
  profile.replace(/[^a-z0-9]/gi, "_").replace(/^_+|_+$/g, "").toUpperCase();

const profileEnv = (
  profile: string,
  key: string,
  alphaFallback?: string | null
): string | undefined => {
  const value = process.env[`${profilePrefix(profile)}_${key}`];
  if (configured(value)) return value;
  return profile === "alpha" && configured(alphaFallback) ? alphaFallback : undefined;
};

const optionalProfileJsonEnv = (
  profile: string,
  key: string,
  alphaFallbackName?: string
): Record<string, unknown> | undefined => {
  const value =
    process.env[`${profilePrefix(profile)}_${key}`] ??
    (profile === "alpha" && alphaFallbackName ? process.env[alphaFallbackName] : undefined);
  if (!value) return undefined;
  return JSON.parse(value) as Record<string, unknown>;
};

const requiredProfileEnv = (
  profile: string,
  key: string,
  alphaFallbackName?: string
): string => {
  const value =
    process.env[`${profilePrefix(profile)}_${key}`] ??
    (profile === "alpha" && alphaFallbackName ? process.env[alphaFallbackName] : undefined);
  if (!configured(value)) {
    throw new Error(`${profilePrefix(profile)}_${key} is required for demo profile ${profile}`);
  }
  return value;
};

const resolveDemoProfile = (
  config: AppConfig,
  input: { profile?: string | null; account?: string } = {}
): DemoAnchorProfile => {
  const id = normalizeProfileId(input.profile);
  const account =
    input.account ??
    profileEnv(id, "PUBLIC_KEY", config.demoAccounts.alpha ?? config.demoAnchorAccount);
  if (!configured(account)) {
    throw new Error(`${profilePrefix(id)}_PUBLIC_KEY is required for demo profile ${id}`);
  }
  const signerSecretKey = profileEnv(id, "ANCHOR_SECRET_KEY", config.demoAnchorSecretKey);
  const confidentialSk = profileEnv(id, "CONFIDENTIAL_SK", config.demoAnchorConfidentialSk);
  const collateralAmount = profileEnv(id, "COLLATERAL_AMOUNT", config.demoAnchorCollateralAmount);
  const collateralRandomness = profileEnv(
    id,
    "COLLATERAL_RANDOMNESS",
    config.demoAnchorCollateralRandomness
  );
  return {
    id,
    account,
    ...(signerSecretKey ? { signerSecretKey } : {}),
    ...(confidentialSk ? { confidentialSk } : {}),
    ...(collateralAmount ? { collateralAmount } : {}),
    ...(collateralRandomness ? { collateralRandomness } : {}),
    organizationName:
      profileEnv(id, "ORGANIZATION_NAME", "Alpha Remit") ??
      `${id.slice(0, 1).toUpperCase()}${id.slice(1)} Remit`,
    emailAddress:
      profileEnv(id, "EMAIL_ADDRESS", "ops@alpha-remit.example") ??
      `ops@${id.replace(/[^a-z0-9-]/g, "-")}.example`,
    drawTransferDataXdrBase64: requiredProfileEnv(
      id,
      "DRAW_TRANSFER_DATA_XDR_BASE64",
      "DRAW_TRANSFER_DATA_XDR_BASE64"
    ),
    drawAuditorPayload: optionalProfileJsonEnv(id, "DRAW_AUDITOR_PAYLOAD_JSON", "DRAW_AUDITOR_PAYLOAD_JSON"),
    repaymentTransferDataXdrBase64: requiredProfileEnv(
      id,
      "REPAYMENT_TRANSFER_DATA_XDR_BASE64",
      "REPAYMENT_TRANSFER_DATA_XDR_BASE64"
    ),
    repaymentAuditorPayload: optionalProfileJsonEnv(
      id,
      "REPAYMENT_AUDITOR_PAYLOAD_JSON",
      "REPAYMENT_AUDITOR_PAYLOAD_JSON"
    )
  };
};

const randomHex32 = (): string => randomBytes(31).toString("hex").padStart(64, "0");

const commandEnv = (config: AppConfig): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: [
    resolve(config.ozConfidentialRoot, "scripts/bin"),
    process.env.HOME ? resolve(process.env.HOME, ".nargo/bin") : null,
    process.env.HOME ? resolve(process.env.HOME, ".bb") : null,
    process.env.PATH ?? ""
  ]
    .filter((value): value is string => Boolean(value))
    .join(":")
});

const createCollateralFixture = (
  config: AppConfig,
  oraclePriceE7: string,
  profile: DemoAnchorProfile
): CollateralFixture => {
  if (!profile.confidentialSk || !profile.collateralAmount || !profile.collateralRandomness) {
    throw new Error(
      `${profilePrefix(profile.id)}_CONFIDENTIAL_SK / _COLLATERAL_AMOUNT / _COLLATERAL_RANDOMNESS are required: the collateral-sufficiency proof must bind to the anchor's real on-chain spendable_balance opening`
    );
  }
  const lockKey = randomHex32();
  const positionSecret = BigInt(`0x${randomBytes(16).toString("hex")}`).toString(10);
  const result = spawnSync(
    "cargo",
    [
      "run",
      "-q",
      "-p",
      "oz-confidential-runner",
      "--",
      "collateral-fixture",
      lockKey,
      positionSecret,
      oraclePriceE7,
      profile.confidentialSk,
      profile.collateralAmount,
      profile.collateralRandomness
    ],
    {
      cwd: resolve(config.ozConfidentialRoot),
      env: commandEnv(config),
      encoding: "utf8"
    }
  );
  if (result.status !== 0) {
    throw new Error(`collateral fixture generation failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as CollateralFixture;
};

const createRepaymentHistoryFixture = (
  config: AppConfig,
  positionId: string
): RepaymentHistoryFixture => {
  const proofSecret = BigInt(`0x${randomBytes(16).toString("hex")}`).toString(10);
  const result = spawnSync(
    "cargo",
    [
      "run",
      "-q",
      "-p",
      "oz-confidential-runner",
      "--",
      "repayment-history-fixture",
      positionId,
      proofSecret
    ],
    {
      cwd: resolve(config.ozConfidentialRoot),
      env: commandEnv(config),
      encoding: "utf8"
    }
  );
  if (result.status !== 0) {
    throw new Error(`repayment history fixture generation failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as RepaymentHistoryFixture;
};

const optionalJsonEnv = (name: string): Record<string, unknown> | undefined => {
  const value = process.env[name];
  if (!value) return undefined;
  return JSON.parse(value) as Record<string, unknown>;
};

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!configured(value)) {
    throw new Error(`${name} is required for live demo orchestration`);
  }
  return value;
};

const resolveQuote = (db: AppDatabase, quoteId?: string): PrefundingQuote => {
  const quote = quoteId ? getQuoteById(db, quoteId) : getLatestQuote(db);
  if (!quote) throw new Error("No prefunding quote found. Call /api/prefunding/quote first.");
  return quote;
};

const resolveAnchorTransactionId = (
  db: AppDatabase,
  input: { anchorTransactionId?: string; quote?: PrefundingQuote | null }
): string | null => {
  if (input.anchorTransactionId) return input.anchorTransactionId;
  if (input.quote?.anchorTransactionId) return input.quote.anchorTransactionId;
  return getLatestAnchorTransaction(db)?.anchor_transaction_id ?? null;
};

const resolveFacility = (config: AppConfig): string => {
  const facility = config.demoAccounts.facility ?? config.distributionAccount;
  if (!configured(facility)) throw new Error("FACILITY_PUBLIC_KEY or DISTRIBUTION_ACCOUNT is required");
  return facility;
};

export const bootstrapDemoFlow = async (
  config: AppConfig,
  db: AppDatabase,
  input: {
    profile?: string;
    anchorTransactionId?: string;
    account?: string;
    kybStatus?: string;
  } = {}
) => {
  const profile = resolveDemoProfile(config, input);
  const account = profile.account;
  const anchorTransactionId =
    input.anchorTransactionId ??
    (profile.id === "alpha" ? demoSep31TransactionId() : `sep31-${profile.id}-001`);
  const transaction = createSep31Transaction(config, db, {
    id: anchorTransactionId,
    account,
    sender_id: account,
    receiver_id: resolveFacility(config),
    status: "pending_sender",
    amount_in: "50000",
    amount_out: "50000",
    asset_code: "cUSDC",
    fields: {
      corridor: "USD-PHP",
      settlement_window_days: 3,
      product: "private_prefunding"
    }
  });

  const customer = await putSep12Customer(config, db, {
    id: `${profile.id}-kyb-001`,
    account,
    type: "sep31-sender",
    status: input.kybStatus ?? "ACCEPTED",
    fields: {
      organization_name: profile.organizationName,
      email_address: profile.emailAddress
    }
  });

  const state = putStoredState(db, {
    ...getStoredState(db),
    profileId: profile.id,
    anchorTransactionId,
    updatedAt: nowIso()
  });

  return {
    transaction,
    customer,
    state,
    demoReady: {
      sep31Seeded: true,
      sep12Seeded: true,
      profileId: profile.id,
      participantPolicySynced:
        typeof customer.participantPolicy === "object" &&
        "synced" in customer.participantPolicy &&
        customer.participantPolicy.synced === true
    }
  };
};

export const resetDemoFlow = async (
  config: AppConfig,
  db: AppDatabase,
  input: {
    profile?: string;
    anchorTransactionId?: string;
    account?: string;
    kybStatus?: string;
  } = {}
) => {
  const profile = resolveDemoProfile(config, input);
  const anchorTransactionId = input.anchorTransactionId ?? freshDemoSep31TransactionId(profile.id);
  putStoredState(db, {
    ...blankState(),
    profileId: profile.id,
    anchorTransactionId
  });
  return bootstrapDemoFlow(config, db, {
    ...input,
    profile: profile.id,
    account: profile.account,
    anchorTransactionId,
    kybStatus: input.kybStatus ?? "ACCEPTED"
  });
};

// v2 (F1/C1) canonical order: c_spend(x,y) | Y(x,y) | credit_commitment(x,y) |
// oracle_price_e7 | haircut_bps | tenor_days | lock_key | position_nullifier
// -- must byte-match `PrefundingCreditLineContract::public_inputs`.
const publicInputsFromFixture = (fixture: CollateralFixture): string[] => [
  fixture.hex.collateralCommitmentX,
  fixture.hex.collateralCommitmentY,
  fixture.hex.yX,
  fixture.hex.yY,
  fixture.hex.creditCommitmentX,
  fixture.hex.creditCommitmentY,
  fixture.hex.oraclePriceE7,
  fixture.hex.haircutBps,
  fixture.hex.tenorDays,
  fixture.hex.lockKey,
  fixture.hex.positionNullifier
];

const runTargetProofJob = async <TPayload, TResult>(
  config: AppConfig,
  db: AppDatabase,
  jobId: string
): Promise<ProofJob<TPayload, TResult>> => {
  for (let i = 0; i < 10; i += 1) {
    const job = getProofJob<TPayload, TResult>(db, jobId);
    if (!job) throw new Error(`proof job not found: ${jobId}`);
    if (job.status === "succeeded") return job;
    if (job.status === "failed") throw new Error(job.error ?? "proof job failed");
    await processNextProofJob(config, db);
  }
  const job = getProofJob<TPayload, TResult>(db, jobId);
  throw new Error(`proof job did not finish: ${job?.status ?? "missing"}`);
};

export const getDemoFlowState = (config: AppConfig, db: AppDatabase) => {
  const state = getStoredState(db);
  const anchorTransaction = state.anchorTransactionId
    ? getAnchorTransactionById(db, state.anchorTransactionId)
    : getLatestAnchorTransaction(db);
  const transfers = listConfidentialTransferEvidence(db, {
    ...(state.positionId ? { positionId: state.positionId } : {}),
    ...(state.anchorTransactionId ? { anchorTransactionId: state.anchorTransactionId } : {}),
    limit: 10
  });

  return {
    state,
    anchorTransaction: anchorTransaction
      ? {
          id: anchorTransaction.anchor_transaction_id,
          sepStatus: anchorTransaction.sep_status,
          productStatus: anchorTransaction.product_status,
          account: anchorTransaction.account,
          amountIn: anchorTransaction.amount_in,
          assetCode: anchorTransaction.asset_code,
          stellarTransactionId: anchorTransaction.stellar_transaction_id
        }
      : null,
    artifactStatus: {
      profileId: state.profileId ?? normalizeProfileId(),
      drawTransferDataXdrConfigured: configured(process.env.DRAW_TRANSFER_DATA_XDR_BASE64),
      repaymentTransferDataXdrConfigured: configured(process.env.REPAYMENT_TRANSFER_DATA_XDR_BASE64),
      creditExecutorConfigured: configured(config.creditExecutorSecretKey),
      demoAnchorSignerConfigured: configured(config.demoAnchorSecretKey)
    },
    contracts: config.contracts,
    transfers
  };
};

export const openDemoCredit = async (
  config: AppConfig,
  db: AppDatabase,
  input: { quoteId?: string; anchorTransactionId?: string; profile?: string } = {}
) => {
  const quote = resolveQuote(db, input.quoteId);
  const profile = resolveDemoProfile(config, {
    profile: input.profile ?? getStoredState(db).profileId,
    account: quote.account
  });
  const anchorTransactionId = resolveAnchorTransactionId(db, {
    anchorTransactionId: input.anchorTransactionId,
    quote
  });
  const positionId = randomHex32();
  const fixture = createCollateralFixture(config, quote.oraclePriceE7, profile);
  const publicInputs = publicInputsFromFixture(fixture);

  if (
    quote.oraclePriceE7 !== fixture.oraclePriceE7 ||
    quote.haircutBps !== fixture.haircutBps ||
    quote.tenorDays !== fixture.tenorDays
  ) {
    throw new Error("quote does not match generated collateral proof fixture");
  }

  const proofJob = createCollateralSufficiencyJob(db, {
    quoteId: quote.id,
    sk: fixture.sk,
    collateralAmount: fixture.collateralAmount,
    collateralRandomness: fixture.collateralRandomness,
    creditAmount: fixture.creditAmount,
    creditRandomness: fixture.creditRandomness,
    positionSecret: fixture.positionSecret,
    collateralCommitmentX: fixture.collateralCommitmentX,
    collateralCommitmentY: fixture.collateralCommitmentY,
    yX: fixture.yX,
    yY: fixture.yY,
    creditCommitmentX: fixture.creditCommitmentX,
    creditCommitmentY: fixture.creditCommitmentY,
    oraclePriceE7: quote.oraclePriceE7,
    haircutBps: quote.haircutBps,
    tenorDays: quote.tenorDays,
    lockKey: fixture.lockKey,
    positionNullifier: fixture.positionNullifier
  });
  const proof = await runTargetProofJob<
    CollateralSufficiencyProofPayload,
    CollateralSufficiencyProofResult
  >(config, db, proofJob.id);
  if (!proof.result) throw new Error("proof job succeeded without result");
  if (proof.result.publicInputsHex !== publicInputs.join("")) {
    throw new Error("proof public inputs do not match generated credit-open payload");
  }

  if (!profile.signerSecretKey) {
    throw new Error("anchor signer secret is not configured for this profile (ANCHOR_SECRET_KEY)");
  }
  const open = await openCreditLine(config, db, {
    ...(anchorTransactionId ? { anchorTransactionId } : {}),
    positionId,
    anchor: quote.account,
    anchorSecretKey: profile.signerSecretKey,
    collateralToken: quote.collateralToken,
    lockKey: publicInputs[9] ?? fixture.hex.lockKey,
    creditCommitmentX: publicInputs[4] ?? fixture.hex.creditCommitmentX,
    creditCommitmentY: publicInputs[5] ?? fixture.hex.creditCommitmentY,
    oraclePriceE7: quote.oraclePriceE7,
    haircutBps: quote.haircutBps,
    tenorDays: quote.tenorDays,
    positionNullifier: publicInputs[10] ?? fixture.hex.positionNullifier,
    publicInputsHex: proof.result.publicInputsHex,
    proofHex: proof.result.proofHex
  });

  const state = putStoredState(db, {
    ...getStoredState(db),
    profileId: profile.id,
    anchorTransactionId,
    positionId,
    quote,
    proof: {
      jobId: proof.id,
      status: proof.status,
      publicInputsHex: proof.result.publicInputsHex,
      proofHex: proof.result.proofHex,
      verifierContractId: config.contracts.collateralSufficiencyVerifier
    },
    open: { txHash: open.hash, ledger: open.ledger ?? null },
    draw: null,
    repay: null,
    historyProof: null,
    updatedAt: nowIso()
  });

  return { state, proofJob: proof, open };
};

export const drawDemoCredit = async (
  config: AppConfig,
  db: AppDatabase,
  input: { anchorTransactionId?: string; positionId?: string; profile?: string } = {}
) => {
  const current = getStoredState(db);
  const profile = resolveDemoProfile(config, {
    profile: input.profile ?? current.profileId,
    account: current.quote?.account
  });
  const anchorTransactionId = input.anchorTransactionId ?? current.anchorTransactionId ?? undefined;
  const positionId = input.positionId ?? current.positionId;
  if (!positionId) throw new Error("No opened demo position found. Run /api/demo-flow/open first.");
  const quote = current.quote ?? getLatestQuote(db);
  if (!quote) throw new Error("No quote found for demo draw");
  const facility = resolveFacility(config);

  // K2: the draw's commitment must equal the position's proven
  // credit_commitment exactly. Public-input layout (v2, 11 x 32-byte
  // fields): c_spend(0,1) | Y(2,3) | credit_commitment(4,5) | oracle(6) |
  // haircut(7) | tenor(8) | lock_key(9) | nullifier(10) -- indices 4/5 are
  // bytes [256:320) and [320:384) of the concatenated hex.
  const publicInputsHex = current.proof?.publicInputsHex;
  if (!publicInputsHex) throw new Error("No collateral-sufficiency proof found for this position");
  const transferCommitmentX = publicInputsHex.slice(256, 320);
  const transferCommitmentY = publicInputsHex.slice(320, 384);

  if (!config.creditExecutorSecretKey) {
    throw new Error("CREDIT_EXECUTOR_SECRET_KEY is required: execute_draw needs credit_executor's require_auth()");
  }

  const draw = await executeDraw(config, db, {
    ...(anchorTransactionId ? { anchorTransactionId } : {}),
    positionId,
    facility,
    transferCommitmentX,
    transferCommitmentY,
    creditExecutorSecretKey: config.creditExecutorSecretKey,
    confidentialTransfer: {
      tokenContractId: config.contracts.confidentialCusdc ?? undefined,
      method: "confidential_transfer_from",
      from: facility,
      to: quote.account,
      dataXdrBase64: profile.drawTransferDataXdrBase64,
      auditorPayload: profile.drawAuditorPayload
    }
  });

  const state = putStoredState(db, {
    ...current,
    profileId: profile.id,
    anchorTransactionId: anchorTransactionId ?? current.anchorTransactionId,
    positionId,
    quote,
    draw: {
      txHash: draw.hash,
      ledger: draw.ledger ?? null,
      confidentialTransferTxHash: draw.confidentialTransfer?.txHash ?? null,
      transferCommitment: transferCommitmentX
    },
    updatedAt: nowIso()
  });
  return { state, draw };
};

export const repayDemoCredit = async (
  config: AppConfig,
  db: AppDatabase,
  input: { anchorTransactionId?: string; positionId?: string; profile?: string } = {}
) => {
  const current = getStoredState(db);
  const profile = resolveDemoProfile(config, {
    profile: input.profile ?? current.profileId,
    account: current.quote?.account
  });
  const anchorTransactionId = input.anchorTransactionId ?? current.anchorTransactionId ?? undefined;
  const positionId = input.positionId ?? current.positionId;
  if (!positionId) throw new Error("No opened demo position found. Run /api/demo-flow/open first.");
  const quote = current.quote ?? getLatestQuote(db);
  if (!quote) throw new Error("No quote found for demo repayment");
  const facility = resolveFacility(config);

  if (!profile.signerSecretKey) {
    throw new Error("anchor signerSecretKey is required: repay needs the anchor's own require_auth()");
  }
  const tokenContractId = config.contracts.confidentialCusdc;
  if (tokenContractId && process.env.REPAYMENT_MERGE_BEFORE_TRANSFER !== "0") {
    // Draw funds land in receiving_balance; the repayment transfer proof is
    // built assuming they've been merged into spendable_balance already.
    // This is balance housekeeping, kept as its own preceding transaction
    // (see the comment on mergeConfidentialBalance).
    await mergeConfidentialBalance(config, tokenContractId, profile.signerSecretKey);
  }

  const repay = await repayCreditLine(config, db, {
    ...(anchorTransactionId ? { anchorTransactionId } : {}),
    positionId,
    facility,
    anchorSecretKey: profile.signerSecretKey,
    repaymentCommitment: REPAYMENT_COMMITMENT,
    confidentialTransfer: {
      tokenContractId: config.contracts.confidentialCusdc ?? undefined,
      method: "confidential_transfer",
      from: quote.account,
      to: facility,
      dataXdrBase64: profile.repaymentTransferDataXdrBase64,
      auditorPayload: profile.repaymentAuditorPayload
    }
  });

  if (anchorTransactionId) {
    markSep31Completed(config, db, anchorTransactionId, {
      settlementReference: `settlement-${anchorTransactionId}`,
      note: "Demo settlement completed after private prefunding repayment"
    });
  }

  const state = putStoredState(db, {
    ...current,
    profileId: profile.id,
    anchorTransactionId: anchorTransactionId ?? current.anchorTransactionId,
    positionId,
    quote,
    repay: {
      txHash: repay.hash,
      ledger: repay.ledger ?? null,
      repaymentCommitment: REPAYMENT_COMMITMENT,
      confidentialTransferTxHash: repay.confidentialTransfer?.txHash ?? null
    },
    updatedAt: nowIso()
  });
  return { state, repay };
};

export const proveDemoRepaymentHistory = async (
  config: AppConfig,
  db: AppDatabase,
  input: { positionId?: string; profile?: string } = {}
) => {
  const current = getStoredState(db);
  const profileId = normalizeProfileId(input.profile ?? current.profileId);
  const positionId = input.positionId ?? current.positionId;
  if (!positionId) throw new Error("No opened demo position found. Run /api/demo-flow/open first.");
  if (!current.repay) throw new Error("No repaid demo position found. Run /api/demo-flow/repay first.");
  if (current.historyProof?.verified) {
    return { state: current, historyProof: current.historyProof, alreadyVerified: true };
  }

  const fixture = createRepaymentHistoryFixture(config, positionId);
  const [leaf0, leaf1, leaf2] = fixture.leaves;
  if (!leaf0 || !leaf1 || !leaf2) throw new Error("repayment history fixture must contain three leaves");

  const seedLeafTxs = [];
  for (const leaf of fixture.leaves) {
    seedLeafTxs.push(
      await seedRepaymentLeaf(config, db, {
        positionId,
        leafNullifier: leaf.leafNullifier,
        repaymentCommitment: leaf.repaymentCommitment,
        paidLedger: leaf.paidLedger,
        dueLedger: leaf.dueLedger
      })
    );
  }

  const rootTx = await setRepaymentHistoryRoot(config, { positionId });

  const proofJob = createRepaymentHistoryJob(db, {
    positionId: fixture.positionId,
    repaymentAmount0: leaf0.repaymentAmount,
    paidLedger0: leaf0.paidLedger,
    dueLedger0: leaf0.dueLedger,
    leafSecret0: leaf0.leafSecret,
    repaymentAmount1: leaf1.repaymentAmount,
    paidLedger1: leaf1.paidLedger,
    dueLedger1: leaf1.dueLedger,
    leafSecret1: leaf1.leafSecret,
    repaymentAmount2: leaf2.repaymentAmount,
    paidLedger2: leaf2.paidLedger,
    dueLedger2: leaf2.dueLedger,
    leafSecret2: leaf2.leafSecret,
    proofSecret: fixture.proofSecret,
    historyRoot: fixture.historyRoot,
    threshold: fixture.threshold,
    proofNullifier: fixture.proofNullifier
  });
  const proof = await runTargetProofJob<
    RepaymentHistoryProofPayload,
    RepaymentHistoryProofResult
  >(config, db, proofJob.id);
  if (!proof.result) throw new Error("repayment history proof job succeeded without result");
  if (proof.result.publicInputsHex !== fixture.publicInputsHex) {
    throw new Error("repayment history proof public inputs do not match fixture");
  }

  const verifyTx = await verifyRepaymentHistory(config, {
    positionId,
    threshold: fixture.threshold,
    proofNullifier: fixture.hex.proofNullifier,
    publicInputsHex: proof.result.publicInputsHex,
    proofHex: proof.result.proofHex
  });

  const historyProof = {
    jobId: proof.id,
    status: proof.status,
    verified: true,
    txHash: verifyTx.hash,
    ledger: verifyTx.ledger ?? null,
    proofNullifier: fixture.hex.proofNullifier,
    historyRoot: fixture.hex.historyRoot,
    threshold: fixture.threshold,
    onTimeCount: fixture.leaves.filter((leaf) => leaf.onTime).length,
    leafCount: fixture.leaves.length,
    publicInputsHex: proof.result.publicInputsHex,
    verifierContractId: config.contracts.repaymentHistoryVerifier
  };

  const state = putStoredState(db, {
    ...current,
    profileId,
    positionId,
    historyProof,
    updatedAt: nowIso()
  });

  return { state, historyProof, fixture: { threshold: fixture.threshold, onTimeCount: historyProof.onTimeCount, leafCount: historyProof.leafCount }, seedLeafTxs, rootTx, verifyTx };
};
