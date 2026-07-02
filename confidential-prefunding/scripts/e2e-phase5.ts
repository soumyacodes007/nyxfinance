import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { CollateralSufficiencyProofResult } from "../backend/src/types/proof.js";

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

const readPhase4Report = (ozRoot: string): { accounts: Record<string, string> } => {
  const reportPath = resolve(ozRoot, "state", "phase4-testnet-report.json");
  return JSON.parse(readFileSync(reportPath, "utf8")) as { accounts: Record<string, string> };
};

const createCollateralFixture = (ozRoot: string, oraclePriceE7: string): CollateralFixture => {
  const lockKeyHex = randomBytes(31).toString("hex").padStart(64, "0");
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
      lockKeyHex,
      positionSecret,
      oraclePriceE7
    ],
    {
      cwd: resolve(ozRoot),
      encoding: "utf8"
    }
  );
  if (result.status !== 0) {
    throw new Error(`collateral fixture failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as CollateralFixture;
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

const requireSyncedPolicy = (result: Json, label: string): void => {
  const participantPolicy = result.participantPolicy as { synced?: boolean; reason?: string } | undefined;
  if (!participantPolicy?.synced) {
    throw new Error(`${label} did not sync ParticipantPolicy: ${participantPolicy?.reason ?? "unknown"}`);
  }
};

loadDotEnv();

const [{ config }, { openAppDatabase, getProofJob }, { buildApi }, { processNextProofJob }] =
  await Promise.all([
    import("../backend/src/lib/env.js"),
    import("../backend/src/db/sqlite.js"),
    import("../backend/src/app.js"),
    import("../backend/src/services/prover-worker.js")
  ]);

const db = openAppDatabase(config.appStateDbPath);
const app = await buildApi(config, db);

try {
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;
  const client = createClient(`http://127.0.0.1:${address.port}`);
  const phase4Report = readPhase4Report(config.ozConfidentialRoot);
  const alpha = phase4Report.accounts.alpha;
  const facility = config.demoAccounts.facility ?? config.distributionAccount;
  const anchorTransactionId = `anchor-e2e-${Date.now()}`;
  const drawTransferDataXdrBase64 = requiredEnv("DRAW_TRANSFER_DATA_XDR_BASE64");

  if (!alpha) throw new Error("phase4 report is missing Alpha account");
  if (!facility || facility === "REPLACE_ME") throw new Error("FACILITY_PUBLIC_KEY or DISTRIBUTION_ACCOUNT is not configured");

  await client.post("/api/anchor/transactions", {
    id: anchorTransactionId,
    account: alpha,
    status: "pending_sender",
    amount_in: "1000",
    asset_code: "tUSDC"
  });

  const rejected = await client.post<Json>("/api/anchor/customer/status", {
    customerId: `${anchorTransactionId}-alpha-rejected`,
    account: alpha,
    status: "REJECTED"
  });
  requireSyncedPolicy(rejected, "REJECTED Alpha");

  const rejectedQuote = await client.post<Json>(
    "/api/prefunding/quote",
    {
      anchorTransactionId,
      account: alpha,
      collateralToken: config.contracts.collateralToken,
      requestedCreditAmount: "1000",
      tenorDays: 3
    },
    false
  );
  if (!("error" in rejectedQuote)) {
    throw new Error("REJECTED Alpha unexpectedly received a quote");
  }

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
  const fixture = createCollateralFixture(config.ozConfidentialRoot, quote.oraclePriceE7);
  if (
    quote.oraclePriceE7 !== fixture.oraclePriceE7 ||
    quote.haircutBps !== fixture.haircutBps ||
    quote.tenorDays !== fixture.tenorDays
  ) {
    throw new Error(`quote does not match the Phase 4 circuit fixture: ${JSON.stringify(quote)}`);
  }

  const publicInputs: [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string
  ] = [
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

  const proofJob = await client.post<{ id: string }>("/api/proof/collateral-sufficiency", {
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

  await processNextProofJob(config, db);
  const completedProof = getProofJob(db, proofJob.id) as {
    status: string;
    result: CollateralSufficiencyProofResult | null;
    error: string | null;
  } | null;
  if (completedProof?.status !== "succeeded" || !completedProof.result) {
    throw new Error(`proof job failed: ${completedProof?.error ?? "missing job"}`);
  }

  const expectedPublicInputsHex = publicInputs.join("");
  if (completedProof.result.publicInputsHex !== expectedPublicInputsHex) {
    throw new Error("proof public inputs do not match the credit-open payload");
  }

  const positionId = randomBytes(32).toString("hex");
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
    publicInputsHex: completedProof.result.publicInputsHex,
    proofHex: completedProof.result.proofHex
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
    repaymentCommitment: "5555555555555555555555555555555555555555555555555555555555555555"
  });

  const watcher = await client.post("/api/watcher/sync", {});
  const finalState = await client.get("/api/demo/state");

  console.log(
    JSON.stringify(
      {
        anchorTransactionId,
        participantPolicy: { rejected, accepted },
        quote,
        proofJob: { id: proofJob.id, status: completedProof.status },
        txs: { open, draw, repay },
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
