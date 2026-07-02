import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import type {
  CollateralSufficiencyProofResult,
  RepaymentHistoryProofResult
} from "../backend/src/types/proof.js";

type Json = Record<string, unknown>;

type CollateralFixture = {
  collateralAmount: string;
  collateralRandomness: string;
  creditAmount: string;
  creditRandomness: string;
  positionSecret: string;
  collateralCommitmentX: string;
  collateralCommitmentY: string;
  creditCommitmentX: string;
  creditCommitmentY: string;
  oraclePriceE7: string;
  haircutBps: number;
  tenorDays: number;
  lockKey: string;
  positionNullifier: string;
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

type RepaymentFixture = {
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

type Phase4Report = {
  accounts: Record<string, string>;
  contracts: Record<string, string>;
};

type ProofOfLifeReport = {
  accounts?: Record<string, string>;
  contracts?: Record<string, string>;
  tests?: Record<string, unknown>;
};

type Phase6Deployments = {
  repayment_history_verifier: string;
  repayment_history_registry: string;
  disclosure_grant_registry: string;
};

const loadDotEnv = (path = ".env"): void => {
  const envPath = resolve(path);
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const splitAt = trimmed.indexOf("=");
    if (splitAt < 1) continue;
    const key = trimmed.slice(0, splitAt).trim();
    let value = trimmed.slice(splitAt + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
};

const isConfigured = (value: string | undefined): value is string =>
  Boolean(value && value !== "REPLACE_ME" && !value.startsWith("TODO_"));

const commandEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: [
    resolve("oz-confidential/scripts/bin"),
    process.env.HOME ? resolve(process.env.HOME, ".nargo/bin") : null,
    process.env.HOME ? resolve(process.env.HOME, ".bb") : null,
    process.env.PATH ?? ""
  ]
    .filter((value): value is string => Boolean(value))
    .join(":")
});

const runCommand = (
  command: string,
  args: string[],
  options: { cwd?: string; allowFailure?: boolean } = {}
): { stdout: string; stderr: string; status: number } => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? resolve("."),
    env: commandEnv(),
    encoding: "utf8"
  });
  const status = result.status ?? 1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${stderr || stdout}`);
  }
  return { stdout, stderr, status };
};

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

const updateEnvFile = (path: string, values: Record<string, string>): void => {
  const envPath = resolve(path);
  const existing = readFileSync(envPath, "utf8");
  const seen = new Set<string>();
  const lines = existing.split(/\r?\n/).map((line) => {
    const key = line.includes("=") ? line.slice(0, line.indexOf("=")) : line;
    if (!Object.prototype.hasOwnProperty.call(values, key)) return line;
    seen.add(key);
    return `${key}=${values[key] ?? ""}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }
  writeFileSync(envPath, lines.join("\n"));
};

const ensurePhase6Contracts = (ozRoot: string): Phase6Deployments => {
  const existing = {
    disclosure_grant_registry: process.env.DISCLOSURE_GRANT_REGISTRY_CONTRACT_ID,
    repayment_history_registry: process.env.REPAYMENT_HISTORY_CONTRACT_ID,
    repayment_history_verifier: process.env.REPAYMENT_HISTORY_VERIFIER_CONTRACT_ID
  };
  if (
    isConfigured(existing.disclosure_grant_registry) &&
    isConfigured(existing.repayment_history_registry) &&
    isConfigured(existing.repayment_history_verifier) &&
    process.env.PHASE6_REDEPLOY !== "1"
  ) {
    return {
      disclosure_grant_registry: existing.disclosure_grant_registry,
      repayment_history_registry: existing.repayment_history_registry,
      repayment_history_verifier: existing.repayment_history_verifier
    };
  }

  const reportPath = resolve(ozRoot, "state", "phase6-testnet-deployments.json");
  if (!existsSync(reportPath) || process.env.PHASE6_REDEPLOY === "1") {
    console.error("deploying Phase 6 contracts because .env does not contain usable IDs");
    runCommand("cargo", ["run", "-q", "-p", "oz-confidential-runner", "--", "phase6-testnet-deploy"], {
      cwd: resolve(ozRoot)
    });
  }

  const report = readJson<{ contracts: Phase6Deployments }>(reportPath);
  const values = {
    DISCLOSURE_GRANT_REGISTRY_CONTRACT_ID: report.contracts.disclosure_grant_registry,
    REPAYMENT_HISTORY_CONTRACT_ID: report.contracts.repayment_history_registry,
    REPAYMENT_HISTORY_VERIFIER_CONTRACT_ID: report.contracts.repayment_history_verifier
  };
  updateEnvFile(".env", values);
  Object.assign(process.env, values);
  return report.contracts;
};

const startDockerStack = (): { skipped: boolean; status?: number; reason?: string } => {
  if (process.env.PHASE6_SKIP_DOCKER === "1") {
    return { skipped: true, reason: "PHASE6_SKIP_DOCKER=1" };
  }
  console.error("starting Docker Compose stack");
  const result = runCommand("docker", ["compose", "up", "-d", "--build"], { allowFailure: true });
  if (result.status !== 0) {
    return {
      skipped: false,
      status: result.status,
      reason: result.stderr || result.stdout || "docker compose failed"
    };
  }
  return { skipped: false, status: 0 };
};

const waitForHttp = async (url: string, attempts = 30): Promise<{ reachable: boolean; status?: number; error?: string }> => {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return { reachable: true, status: response.status };
    } catch (error) {
      if (i === attempts - 1) {
        return { reachable: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 2000));
  }
  return { reachable: false, error: "timeout" };
};

const friendbotFund = async (friendbotUrl: string, account: string) => {
  try {
    const url = new URL(friendbotUrl);
    url.searchParams.set("addr", account);
    const response = await fetch(url);
    return { account, ok: response.ok, status: response.status };
  } catch (error) {
    return { account, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

const createCollateralFixture = (ozRoot: string, oraclePriceE7: string): CollateralFixture => {
  const lockKeyHex = randomBytes(31).toString("hex").padStart(64, "0");
  const positionSecret = BigInt(`0x${randomBytes(16).toString("hex")}`).toString(10);
  const result = runCommand(
    "cargo",
    [
      "run",
      "-q",
      "-p",
      "oz-confidential-runner",
      "--",
      "collateral-fixture",
      lockKeyHex,
      positionSecret,
      oraclePriceE7
    ],
    { cwd: resolve(ozRoot) }
  );
  return JSON.parse(result.stdout) as CollateralFixture;
};

const createRepaymentFixture = (ozRoot: string, positionId: string): RepaymentFixture => {
  const proofSecret = BigInt(`0x${randomBytes(16).toString("hex")}`).toString(10);
  const result = runCommand(
    "cargo",
    ["run", "-q", "-p", "oz-confidential-runner", "--", "repayment-history-fixture", positionId, proofSecret],
    { cwd: resolve(ozRoot) }
  );
  return JSON.parse(result.stdout) as RepaymentFixture;
};

const parseJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const createClient = (baseUrl: string) => {
  const post = async <T = Json>(path: string, body: unknown, expectOk = true): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await parseJson(response);
    if (expectOk && !response.ok) {
      throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
    }
    return payload as T;
  };

  const get = async <T = Json>(path: string): Promise<T> => {
    const response = await fetch(`${baseUrl}${path}`);
    const payload = await parseJson(response);
    if (!response.ok) {
      throw new Error(`${path} failed with ${response.status}: ${JSON.stringify(payload)}`);
    }
    return payload as T;
  };

  return { get, post };
};

const requireSyncedPolicy = (result: Json, label: string): void => {
  const participantPolicy = result.participantPolicy as { synced?: boolean; reason?: string } | undefined;
  if (!participantPolicy?.synced) {
    throw new Error(`${label} did not sync ParticipantPolicy: ${participantPolicy?.reason ?? "unknown"}`);
  }
};

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (!value || value === "REPLACE_ME") {
    throw new Error(`${name} is required for live confidential token transfer E2E`);
  }
  return value;
};

const optionalJsonEnv = (name: string): Record<string, unknown> | undefined => {
  const value = process.env[name];
  if (!value) return undefined;
  return JSON.parse(value) as Record<string, unknown>;
};

loadDotEnv();
const ozRoot = process.env.OZ_CONFIDENTIAL_ROOT ?? "./oz-confidential";
const phase6Contracts = ensurePhase6Contracts(ozRoot);
const dockerStack = startDockerStack();

const [{ config }, dbModule, { buildApi }, { processNextProofJob }, disclosureService] =
  await Promise.all([
    import("../backend/src/lib/env.js"),
    import("../backend/src/db/sqlite.js"),
    import("../backend/src/app.js"),
    import("../backend/src/services/prover-worker.js"),
    import("../backend/src/services/disclosure.js")
  ]);

const { openAppDatabase, getProofJob } = dbModule;
const db = openAppDatabase(config.appStateDbPath);
const app = await buildApi(config, db);

try {
  const anchorReachability = await waitForHttp(config.anchorStellarTomlUrl, 20);

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const client = createClient(`http://127.0.0.1:${address.port}`);

  const phase4Report = readJson<Phase4Report>(resolve(ozRoot, "state", "phase4-testnet-report.json"));
  const proofOfLifeReport = readJson<ProofOfLifeReport>(
    resolve(ozRoot, "state", "proof-of-life-report.json")
  );
  const alpha = phase4Report.accounts.alpha;
  const facility = config.demoAccounts.facility ?? config.distributionAccount;
  const auditor = proofOfLifeReport.accounts?.auditor ?? phase4Report.accounts.admin;
  const anchorTransactionId = `anchor-phase6-${Date.now()}`;
  const positionId = randomBytes(31).toString("hex").padStart(64, "0");
  const drawTransferDataXdrBase64 = requiredEnv("DRAW_TRANSFER_DATA_XDR_BASE64");
  const repaymentTransferDataXdrBase64 = requiredEnv("REPAYMENT_TRANSFER_DATA_XDR_BASE64");

  if (!alpha) throw new Error("phase4 report is missing Alpha account");
  if (!facility || facility === "REPLACE_ME") throw new Error("FACILITY_PUBLIC_KEY or DISTRIBUTION_ACCOUNT is not configured");
  if (!auditor) throw new Error("auditor account is not available");

  const funding = await Promise.all([
    friendbotFund(config.friendbotUrl, alpha),
    friendbotFund(config.friendbotUrl, facility),
    friendbotFund(config.friendbotUrl, auditor)
  ]);

  const confidentialTokenProof = {
    alphaDepositedCTBill:
      Boolean(proofOfLifeReport.contracts?.ctbill) &&
      Boolean(proofOfLifeReport.tests?.set_spender_creates_allowance_commitment),
    facilityDepositedCUSDC: Boolean(proofOfLifeReport.contracts?.cusdc),
    alphaSetCollateralAllowance: Boolean(
      proofOfLifeReport.tests?.set_spender_creates_allowance_commitment
    ),
    auditorDecryptMatches:
      (proofOfLifeReport.tests?.auditor_decrypt_matches_amount as { amount_matches?: boolean } | undefined)
        ?.amount_matches === true,
    source: "oz-confidential/state/proof-of-life-report.json"
  };
  if (!confidentialTokenProof.alphaDepositedCTBill || !confidentialTokenProof.facilityDepositedCUSDC) {
    throw new Error("OZ confidential token proof-of-life report is incomplete");
  }

  await client.post("/api/anchor/transactions", {
    id: anchorTransactionId,
    account: alpha,
    status: "pending_sender",
    amount_in: "1000",
    asset_code: "tUSDC"
  });

  const accepted = await client.post<Json>("/api/anchor/customer/status", {
    customerId: `${anchorTransactionId}-alpha-accepted`,
    account: alpha,
    status: "ACCEPTED"
  });
  requireSyncedPolicy(accepted, "ACCEPTED Alpha");

  const quote = await client.post<{
    id: string;
    oraclePriceE7: string;
    haircutBps: number;
    tenorDays: number;
    participantApproved: boolean;
  }>("/api/prefunding/quote", {
    anchorTransactionId,
    account: alpha,
    collateralToken: config.contracts.collateralToken,
    requestedCreditAmount: "1000",
    tenorDays: 3
  });
  if (!quote.participantApproved) throw new Error("quote did not read ParticipantPolicy approval");
  const collateralFixture = createCollateralFixture(ozRoot, quote.oraclePriceE7);
  if (
    quote.oraclePriceE7 !== collateralFixture.oraclePriceE7 ||
    quote.haircutBps !== collateralFixture.haircutBps ||
    quote.tenorDays !== collateralFixture.tenorDays
  ) {
    throw new Error(`quote does not match the Phase 4 circuit fixture: ${JSON.stringify(quote)}`);
  }

  const publicInputs = [
    collateralFixture.hex.collateralCommitmentX,
    collateralFixture.hex.collateralCommitmentY,
    collateralFixture.hex.creditCommitmentX,
    collateralFixture.hex.creditCommitmentY,
    collateralFixture.hex.oraclePriceE7,
    collateralFixture.hex.haircutBps,
    collateralFixture.hex.tenorDays,
    collateralFixture.hex.lockKey,
    collateralFixture.hex.positionNullifier
  ];

  const collateralProofJob = await client.post<{ id: string }>("/api/proof/collateral-sufficiency", {
    quoteId: quote.id,
    collateralAmount: collateralFixture.collateralAmount,
    collateralRandomness: collateralFixture.collateralRandomness,
    creditAmount: collateralFixture.creditAmount,
    creditRandomness: collateralFixture.creditRandomness,
    positionSecret: collateralFixture.positionSecret,
    collateralCommitmentX: collateralFixture.collateralCommitmentX,
    collateralCommitmentY: collateralFixture.collateralCommitmentY,
    creditCommitmentX: collateralFixture.creditCommitmentX,
    creditCommitmentY: collateralFixture.creditCommitmentY,
    oraclePriceE7: quote.oraclePriceE7,
    haircutBps: quote.haircutBps,
    tenorDays: quote.tenorDays,
    lockKey: collateralFixture.lockKey,
    positionNullifier: collateralFixture.positionNullifier
  });

  await processNextProofJob(config, db);
  const collateralProof = getProofJob(
    db,
    collateralProofJob.id
  ) as {
    status: string;
    result: CollateralSufficiencyProofResult | null;
    error: string | null;
  } | null;
  if (collateralProof?.status !== "succeeded" || !collateralProof.result) {
    throw new Error(`collateral proof job failed: ${collateralProof?.error ?? "missing job"}`);
  }
  if (collateralProof.result.publicInputsHex !== publicInputs.join("")) {
    throw new Error("collateral proof public inputs do not match the credit-open payload");
  }

  const open = await client.post("/api/prefunding/open", {
    anchorTransactionId,
    positionId,
    anchor: alpha,
    collateralToken: config.contracts.collateralToken,
    lockKey: publicInputs[7],
    collateralCommitmentX: publicInputs[0],
    collateralCommitmentY: publicInputs[1],
    creditCommitmentX: publicInputs[2],
    creditCommitmentY: publicInputs[3],
    oraclePriceE7: quote.oraclePriceE7,
    haircutBps: quote.haircutBps,
    tenorDays: quote.tenorDays,
    positionNullifier: publicInputs[8],
    publicInputsHex: collateralProof.result.publicInputsHex,
    proofHex: collateralProof.result.proofHex
  });

  const draw = await client.post("/api/prefunding/draw", {
    anchorTransactionId,
    positionId,
    facility,
    transferCommitment: "4444444444444444444444444444444444444444444444444444444444444444",
    confidentialTransfer: {
      tokenContractId: config.contracts.confidentialCusdc,
      method: "confidential_transfer_from",
      from: facility,
      to: alpha,
      dataXdrBase64: drawTransferDataXdrBase64,
      auditorPayload: optionalJsonEnv("DRAW_AUDITOR_PAYLOAD_JSON")
    }
  });

  const repay = await client.post("/api/prefunding/repay", {
    anchorTransactionId,
    positionId,
    repaymentCommitment: "5555555555555555555555555555555555555555555555555555555555555555",
    confidentialTransfer: {
      tokenContractId: config.contracts.confidentialCusdc,
      method: "confidential_transfer",
      from: alpha,
      to: facility,
      dataXdrBase64: repaymentTransferDataXdrBase64,
      auditorPayload: optionalJsonEnv("REPAYMENT_AUDITOR_PAYLOAD_JSON")
    }
  });

  const repaymentFixture = createRepaymentFixture(ozRoot, positionId);
  const [leaf0, leaf1, leaf2] = repaymentFixture.leaves;
  if (!leaf0 || !leaf1 || !leaf2) throw new Error("repayment fixture must contain three leaves");
  const seedLeafTxs = [];
  for (const leaf of repaymentFixture.leaves) {
    seedLeafTxs.push(
      await client.post("/api/repayment-history/seed-leaf", {
        positionId,
        leafNullifier: leaf.leafNullifier,
        repaymentCommitment: leaf.repaymentCommitment,
        paidLedger: leaf.paidLedger,
        dueLedger: leaf.dueLedger
      })
    );
  }
  const duplicateLeaf = await client.post<Json>(
    "/api/repayment-history/seed-leaf",
    {
      positionId,
      leafNullifier: leaf0.leafNullifier,
      repaymentCommitment: leaf0.repaymentCommitment,
      paidLedger: leaf0.paidLedger,
      dueLedger: leaf0.dueLedger
    },
    false
  );
  if (!("error" in duplicateLeaf)) throw new Error("duplicate repayment leaf unexpectedly succeeded");

  const rootTx = await client.post("/api/repayment-history/root", {
    positionId,
    historyRoot: repaymentFixture.hex.historyRoot,
    leafCount: repaymentFixture.leaves.length
  });

  const repaymentProofJob = await client.post<{ id: string }>("/api/proof/repayment-history", {
    positionId: repaymentFixture.positionId,
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
    proofSecret: repaymentFixture.proofSecret,
    historyRoot: repaymentFixture.historyRoot,
    threshold: repaymentFixture.threshold,
    proofNullifier: repaymentFixture.proofNullifier
  });

  await processNextProofJob(config, db);
  const repaymentProof = getProofJob(
    db,
    repaymentProofJob.id
  ) as {
    status: string;
    result: RepaymentHistoryProofResult | null;
    error: string | null;
  } | null;
  if (repaymentProof?.status !== "succeeded" || !repaymentProof.result) {
    throw new Error(`repayment proof job failed: ${repaymentProof?.error ?? "missing job"}`);
  }
  if (repaymentProof.result.publicInputsHex !== repaymentFixture.publicInputsHex) {
    throw new Error("repayment proof public inputs do not match fixture");
  }

  const verifyHistory = await client.post("/api/repayment-history/verify", {
    positionId,
    threshold: repaymentFixture.threshold,
    proofNullifier: repaymentFixture.hex.proofNullifier,
    publicInputsHex: repaymentProof.result.publicInputsHex,
    proofHex: repaymentProof.result.proofHex
  });

  const replayHistory = await client.post<Json>(
    "/api/repayment-history/verify",
    {
      positionId,
      threshold: repaymentFixture.threshold,
      proofNullifier: repaymentFixture.hex.proofNullifier,
      publicInputsHex: repaymentProof.result.publicInputsHex,
      proofHex: repaymentProof.result.proofHex
    },
    false
  );
  if (!("error" in replayHistory)) throw new Error("repayment proof replay unexpectedly succeeded");

  const insufficientHistoryJob = await client.post<{ id: string }>("/api/proof/repayment-history", {
    positionId: repaymentFixture.positionId,
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
    proofSecret: repaymentFixture.proofSecret,
    historyRoot: repaymentFixture.historyRoot,
    threshold: 3,
    proofNullifier: repaymentFixture.proofNullifier
  });
  await processNextProofJob(config, db);
  const insufficientHistoryProof = getProofJob(db, insufficientHistoryJob.id) as {
    status: string;
    error: string | null;
  } | null;
  if (insufficientHistoryProof?.status !== "failed") {
    throw new Error("threshold=3 repayment proof unexpectedly succeeded despite one late repayment");
  }

  const latestLedger = (await client.get<Json>("/api/demo/state")).snapshot as
    | { stellar?: { rpc?: { latestLedgerSequence?: number | null } } }
    | undefined;
  const expiresAtLedger = Number(latestLedger?.stellar?.rpc?.latestLedgerSequence ?? 0) + 250;
  const viewerSecret = `viewer_${randomBytes(24).toString("hex")}`;
  const scopedData = {
    repaymentStatus: "on_time_threshold_met",
    threshold: repaymentFixture.threshold,
    onTimeRepayments: repaymentFixture.leaves.filter((leaf) => leaf.onTime).length,
    repaymentCommitment: "5555555555555555555555555555555555555555555555555555555555555555"
  };
  const disclosure = await client.post<{
    grantId: string;
    viewerSecret: string;
    viewerHash: string;
    scopeHash: string;
    bundleHash: string;
    onChain: { submitted: boolean; txHash?: string; reason?: string };
  }>("/api/disclosure/grants", {
    owner: alpha,
    viewerSecret,
    positionId,
    eventId: (repay as { hash?: string }).hash ?? `${positionId}:repay`,
    scope: {
      fields: ["repaymentStatus", "threshold", "onTimeRepayments", "repaymentCommitment"],
      label: "repayment-status-only"
    },
    scopedData,
    expiresAtLedger,
    auditorCiphertexts: {
      transferPayload: (proofOfLifeReport.tests?.auditor_ciphertext_emitted as Json | undefined)
        ?.transfer_payload,
      decryptedAmountCheck: proofOfLifeReport.tests?.auditor_decrypt_matches_amount
    },
    proof: {
      type: "repayment_history_ultrahonk",
      publicInputsHex: repaymentProof.result.publicInputsHex,
      proofHex: repaymentProof.result.proofHex
    }
  });
  if (!disclosure.onChain.submitted) {
    throw new Error(`disclosure grant did not submit on-chain: ${disclosure.onChain.reason}`);
  }

  const bundleLookup = await client.get<{
    grant: {
      viewerHash: string;
      scopeHash: string;
      bundleHash: string;
      revoked: boolean;
    };
    encryptedBundle: {
      ciphertext: string;
      nonce: string;
      authTag: string;
      algorithm: "aes-256-gcm";
    };
    grantStatus: { revoked: boolean; expired: boolean };
  }>(`/api/disclosure/${disclosure.grantId}`);
  if (JSON.stringify(bundleLookup).includes('"repaymentStatus":"on_time_threshold_met"')) {
    throw new Error("public disclosure endpoint leaked plaintext scoped data");
  }
  if (sha256Hex(viewerSecret) !== bundleLookup.grant.viewerHash) {
    throw new Error("viewer hash mismatch before decrypt");
  }
  const decryptedDisclosure = disclosureService.decryptDisclosurePlaintext(
    bundleLookup.encryptedBundle,
    viewerSecret
  ) as { scopedData: Record<string, unknown>; clientVerification: { expectedScopeHash: string } };
  if (stableJson(decryptedDisclosure.scopedData) !== stableJson(scopedData)) {
    throw new Error("client-side disclosure decrypt did not recover scoped data");
  }
  if (decryptedDisclosure.clientVerification.expectedScopeHash !== bundleLookup.grant.scopeHash) {
    throw new Error("decrypted disclosure scope hash does not match grant metadata");
  }

  const revokedDisclosure = await client.post(`/api/disclosure/${disclosure.grantId}/revoke`, {});
  const revokedLookup = await client.get<{
    grantStatus: { revoked: boolean; expired: boolean };
  }>(`/api/disclosure/${disclosure.grantId}`);
  if (!revokedLookup.grantStatus.revoked) throw new Error("revoked disclosure link still appears valid");

  const watcher = await client.post("/api/watcher/sync", {});
  const finalState = await client.get("/api/demo/state");

  console.log(
    JSON.stringify(
      {
        dockerStack,
        phase6Contracts,
        anchorReachability,
        funding,
        anchorTransaction: {
          id: anchorTransactionId,
          sepStatus: "pending_stellar",
          creationPath: "direct Anchor callback ingestion into backend; Anchor Platform reachability checked separately"
        },
        participantPolicy: { accepted },
        confidentialTokenProof,
        quote,
        proofJobs: {
          collateral: { id: collateralProofJob.id, status: collateralProof.status },
          repaymentHistory: { id: repaymentProofJob.id, status: repaymentProof.status },
          insufficientHistory: {
            id: insufficientHistoryJob.id,
            status: insufficientHistoryProof.status,
            error: insufficientHistoryProof.error
          }
        },
        txs: {
          open,
          draw,
          repay,
          seedLeafTxs,
          rootTx,
          verifyHistory,
          revokedDisclosure
        },
        negativeTests: {
          duplicateRepaymentLeafBlocked: "error" in duplicateLeaf,
          repaymentProofReplayBlocked: "error" in replayHistory,
          lateRepaymentDoesNotSatisfyThreshold: insufficientHistoryProof.status === "failed",
          publicDisclosureEndpointNoPlaintext: true,
          revokedDisclosureLinkFails: revokedLookup.grantStatus.revoked
        },
        disclosure: {
          grantId: disclosure.grantId,
          link: `http://localhost:${config.frontendPort}/disclosure?grantId=${disclosure.grantId}#key=${encodeURIComponent(viewerSecret)}`,
          onChain: disclosure.onChain,
          scopedDataDecryptedClientSide: decryptedDisclosure.scopedData
        },
        watcher,
        finalState
      },
      null,
      2
    )
  );
} finally {
  await app.close();
  db.close();
}
