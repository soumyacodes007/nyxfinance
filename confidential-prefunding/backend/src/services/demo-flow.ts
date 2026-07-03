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
import { createSep31Transaction, markSep31Completed } from "./sep31.js";
import { putSep12Customer } from "./sep12.js";
import {
  seedRepaymentLeaf,
  setRepaymentHistoryRoot,
  verifyRepaymentHistory
} from "./repayment-history.js";

const SNAPSHOT_KEY = "demo_flow_state";
const DRAW_COMMITMENT = "4444444444444444444444444444444444444444444444444444444444444444";
const REPAYMENT_COMMITMENT = "5555555555555555555555555555555555555555555555555555555555555555";

type CollateralFixture = CollateralSufficiencyProofPayload & {
  hex: {
    collateralCommitmentX: string;
    collateralCommitmentY: string;
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

const resolveAlpha = (config: AppConfig, account?: string): string => {
  const alpha = account ?? config.demoAccounts.alpha ?? config.demoAnchorAccount;
  if (!configured(alpha)) throw new Error("ALPHA_PUBLIC_KEY or DEMO_ANCHOR_ACCOUNT is not configured");
  return alpha;
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

const createCollateralFixture = (config: AppConfig, oraclePriceE7: string): CollateralFixture => {
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
      oraclePriceE7
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
    anchorTransactionId?: string;
    account?: string;
    kybStatus?: string;
  } = {}
) => {
  const account = resolveAlpha(config, input.account);
  const anchorTransactionId = input.anchorTransactionId ?? demoSep31TransactionId();
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
    id: "alpha-kyb-001",
    account,
    type: "sep31-sender",
    status: input.kybStatus ?? "ACCEPTED",
    fields: {
      organization_name: "Alpha Remit",
      email_address: "ops@alpha-remit.example"
    }
  });

  const state = putStoredState(db, {
    ...getStoredState(db),
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
      participantPolicySynced:
        typeof customer.participantPolicy === "object" &&
        "synced" in customer.participantPolicy &&
        customer.participantPolicy.synced === true
    }
  };
};

const publicInputsFromFixture = (fixture: CollateralFixture): string[] => [
  fixture.hex.collateralCommitmentX,
  fixture.hex.collateralCommitmentY,
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
  input: { quoteId?: string; anchorTransactionId?: string } = {}
) => {
  const quote = resolveQuote(db, input.quoteId);
  const anchorTransactionId = resolveAnchorTransactionId(db, {
    anchorTransactionId: input.anchorTransactionId,
    quote
  });
  const positionId = randomHex32();
  const fixture = createCollateralFixture(config, quote.oraclePriceE7);
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
    collateralAmount: fixture.collateralAmount,
    collateralRandomness: fixture.collateralRandomness,
    creditAmount: fixture.creditAmount,
    creditRandomness: fixture.creditRandomness,
    positionSecret: fixture.positionSecret,
    collateralCommitmentX: fixture.collateralCommitmentX,
    collateralCommitmentY: fixture.collateralCommitmentY,
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

  const open = await openCreditLine(config, db, {
    ...(anchorTransactionId ? { anchorTransactionId } : {}),
    positionId,
    anchor: quote.account,
    collateralToken: quote.collateralToken,
    lockKey: publicInputs[7] ?? fixture.hex.lockKey,
    collateralCommitmentX: publicInputs[0] ?? fixture.hex.collateralCommitmentX,
    collateralCommitmentY: publicInputs[1] ?? fixture.hex.collateralCommitmentY,
    creditCommitmentX: publicInputs[2] ?? fixture.hex.creditCommitmentX,
    creditCommitmentY: publicInputs[3] ?? fixture.hex.creditCommitmentY,
    oraclePriceE7: quote.oraclePriceE7,
    haircutBps: quote.haircutBps,
    tenorDays: quote.tenorDays,
    positionNullifier: publicInputs[8] ?? fixture.hex.positionNullifier,
    publicInputsHex: proof.result.publicInputsHex,
    proofHex: proof.result.proofHex
  });

  const state = putStoredState(db, {
    ...getStoredState(db),
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
  input: { anchorTransactionId?: string; positionId?: string } = {}
) => {
  const current = getStoredState(db);
  const anchorTransactionId = input.anchorTransactionId ?? current.anchorTransactionId ?? undefined;
  const positionId = input.positionId ?? current.positionId;
  if (!positionId) throw new Error("No opened demo position found. Run /api/demo-flow/open first.");
  const quote = current.quote ?? getLatestQuote(db);
  if (!quote) throw new Error("No quote found for demo draw");
  const facility = resolveFacility(config);

  const draw = await executeDraw(config, db, {
    ...(anchorTransactionId ? { anchorTransactionId } : {}),
    positionId,
    facility,
    transferCommitment: DRAW_COMMITMENT,
    confidentialTransfer: {
      tokenContractId: config.contracts.confidentialCusdc ?? undefined,
      method: "confidential_transfer_from",
      from: facility,
      to: quote.account,
      dataXdrBase64: requiredEnv("DRAW_TRANSFER_DATA_XDR_BASE64"),
      auditorPayload: optionalJsonEnv("DRAW_AUDITOR_PAYLOAD_JSON")
    }
  });

  const state = putStoredState(db, {
    ...current,
    anchorTransactionId: anchorTransactionId ?? current.anchorTransactionId,
    positionId,
    quote,
    draw: {
      txHash: draw.hash,
      ledger: draw.ledger ?? null,
      confidentialTransferTxHash: draw.confidentialTransfer?.txHash ?? null,
      transferCommitment: DRAW_COMMITMENT
    },
    updatedAt: nowIso()
  });
  return { state, draw };
};

export const repayDemoCredit = async (
  config: AppConfig,
  db: AppDatabase,
  input: { anchorTransactionId?: string; positionId?: string } = {}
) => {
  const current = getStoredState(db);
  const anchorTransactionId = input.anchorTransactionId ?? current.anchorTransactionId ?? undefined;
  const positionId = input.positionId ?? current.positionId;
  if (!positionId) throw new Error("No opened demo position found. Run /api/demo-flow/open first.");
  const quote = current.quote ?? getLatestQuote(db);
  if (!quote) throw new Error("No quote found for demo repayment");
  const facility = resolveFacility(config);

  const repay = await repayCreditLine(config, db, {
    ...(anchorTransactionId ? { anchorTransactionId } : {}),
    positionId,
    repaymentCommitment: REPAYMENT_COMMITMENT,
    confidentialTransfer: {
      tokenContractId: config.contracts.confidentialCusdc ?? undefined,
      method: "confidential_transfer",
      from: quote.account,
      to: facility,
      dataXdrBase64: requiredEnv("REPAYMENT_TRANSFER_DATA_XDR_BASE64"),
      mergeBeforeTransfer: process.env.REPAYMENT_MERGE_BEFORE_TRANSFER !== "0",
      auditorPayload: optionalJsonEnv("REPAYMENT_AUDITOR_PAYLOAD_JSON")
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
  input: { positionId?: string } = {}
) => {
  const current = getStoredState(db);
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

  const rootTx = await setRepaymentHistoryRoot(config, {
    positionId,
    historyRoot: fixture.hex.historyRoot,
    leafCount: fixture.leaves.length
  });

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
    positionId,
    historyProof,
    updatedAt: nowIso()
  });

  return { state, historyProof, fixture: { threshold: fixture.threshold, onTimeCount: historyProof.onTimeCount, leafCount: historyProof.leafCount }, seedLeafTxs, rootTx, verifyTx };
};
