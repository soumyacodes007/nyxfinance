import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";
import { nowIso } from "../lib/ids.js";
import type { ProductStatus, SepStatus } from "../types/status.js";
import type { ProofJob, ProofJobStatus, ProofJobType } from "../types/proof.js";
import type { PrefundingQuote } from "../types/quote.js";
import type { DisclosureBundleRecord } from "../types/disclosure.js";
import type { RepaymentLeafRecord } from "../types/repayment-history.js";

export type AppDatabase = Database.Database;

export const openAppDatabase = (databasePath: string): AppDatabase => {
  mkdirSync(dirname(databasePath), { recursive: true });
  const db = new Database(databasePath);
  runMigrations(db);
  return db;
};

export const parseJson = <T>(value: string): T => JSON.parse(value) as T;

export const getSnapshot = <T>(db: AppDatabase, key: string) => {
  const row = db
    .prepare("SELECT key, payload, source_status, source_timestamp, updated_at FROM snapshots WHERE key = ?")
    .get(key) as
    | {
        key: string;
        payload: string;
        source_status: string;
        source_timestamp: string;
        updated_at: string;
      }
    | undefined;

  return row
    ? {
        key: row.key,
        payload: parseJson<T>(row.payload),
        sourceStatus: row.source_status,
        sourceTimestamp: row.source_timestamp,
        updatedAt: row.updated_at
      }
    : null;
};

export const upsertSnapshot = (
  db: AppDatabase,
  key: string,
  payload: unknown,
  sourceStatus: string
): void => {
  const now = nowIso();
  db.prepare(`
    INSERT INTO snapshots (key, payload, source_status, source_timestamp, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      payload = excluded.payload,
      source_status = excluded.source_status,
      source_timestamp = excluded.source_timestamp,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(payload), sourceStatus, now, now, now);
};

export const upsertWatcherCursor = (db: AppDatabase, name: string, cursor: string): void => {
  const now = nowIso();
  db.prepare(`
    INSERT INTO watcher_state (name, cursor, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
  `).run(name, cursor, now);
};

export const getWatcherCursor = (db: AppDatabase, name: string) => {
  const row = db
    .prepare("SELECT cursor, updated_at FROM watcher_state WHERE name = ?")
    .get(name) as { cursor: string; updated_at: string } | undefined;
  return row ? { cursor: row.cursor, updatedAt: row.updated_at } : null;
};

export const upsertCustomerStatus = (
  db: AppDatabase,
  input: {
    customerId: string;
    account: string;
    status: string;
    memo?: string | null;
    reason?: string | null;
    raw: unknown;
  }
): void => {
  const now = nowIso();
  db.prepare(`
    INSERT INTO anchor_customers (customer_id, account, status, memo, reason, raw, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(customer_id) DO UPDATE SET
      account = excluded.account,
      status = excluded.status,
      memo = excluded.memo,
      reason = excluded.reason,
      raw = excluded.raw,
      updated_at = excluded.updated_at
  `).run(
    input.customerId,
    input.account,
    input.status,
    input.memo ?? null,
    input.reason ?? null,
    JSON.stringify(input.raw),
    now,
    now
  );
};

export const getCustomerByIdOrAccount = (
  db: AppDatabase,
  input: { customerId?: string | null; account?: string | null }
) => {
  const row = input.customerId
    ? db.prepare("SELECT * FROM anchor_customers WHERE customer_id = ?").get(input.customerId)
    : input.account
      ? db
          .prepare("SELECT * FROM anchor_customers WHERE account = ? ORDER BY updated_at DESC LIMIT 1")
          .get(input.account)
      : undefined;
  return row as
    | {
        customer_id: string;
        account: string;
        status: string;
        memo: string | null;
        reason: string | null;
        raw: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
};

export const upsertAnchorTransaction = (
  db: AppDatabase,
  input: {
    id: string;
    anchorTransactionId: string;
    stellarTransactionId?: string | null;
    account: string;
    sepStatus: SepStatus;
    productStatus: ProductStatus;
    amountIn?: string | null;
    amountOut?: string | null;
    assetCode?: string | null;
    raw: unknown;
  }
): void => {
  const now = nowIso();
  db.prepare(`
    INSERT INTO anchor_transactions
      (id, anchor_transaction_id, stellar_transaction_id, account, sep_status, product_status,
       amount_in, amount_out, asset_code, raw, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(anchor_transaction_id) DO UPDATE SET
      stellar_transaction_id = excluded.stellar_transaction_id,
      account = excluded.account,
      sep_status = excluded.sep_status,
      product_status = excluded.product_status,
      amount_in = excluded.amount_in,
      amount_out = excluded.amount_out,
      asset_code = excluded.asset_code,
      raw = excluded.raw,
      updated_at = excluded.updated_at
  `).run(
    input.id,
    input.anchorTransactionId,
    input.stellarTransactionId ?? null,
    input.account,
    input.sepStatus,
    input.productStatus,
    input.amountIn ?? null,
    input.amountOut ?? null,
    input.assetCode ?? null,
    JSON.stringify(input.raw),
    now,
    now
  );
};

export const getAnchorTransactionById = (db: AppDatabase, anchorTransactionId: string) => {
  const row = db
    .prepare("SELECT * FROM anchor_transactions WHERE anchor_transaction_id = ?")
    .get(anchorTransactionId) as
    | {
        id: string;
        anchor_transaction_id: string;
        stellar_transaction_id: string | null;
        account: string;
        sep_status: SepStatus;
        product_status: ProductStatus;
        amount_in: string | null;
        amount_out: string | null;
        asset_code: string | null;
        raw: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  return row ?? null;
};

export const updateSepStatus = (
  db: AppDatabase,
  anchorTransactionId: string,
  sepStatus: SepStatus,
  raw?: unknown,
  stellarTransactionId?: string | null
): void => {
  db.prepare(`
    UPDATE anchor_transactions
    SET sep_status = ?,
        stellar_transaction_id = COALESCE(?, stellar_transaction_id),
        raw = COALESCE(?, raw),
        updated_at = ?
    WHERE anchor_transaction_id = ?
  `).run(
    sepStatus,
    stellarTransactionId ?? null,
    raw ? JSON.stringify(raw) : null,
    nowIso(),
    anchorTransactionId
  );
};

export const updateProductStatus = (
  db: AppDatabase,
  anchorTransactionId: string,
  productStatus: ProductStatus
): void => {
  db.prepare(`
    UPDATE anchor_transactions
    SET product_status = ?, updated_at = ?
    WHERE anchor_transaction_id = ?
  `).run(productStatus, nowIso(), anchorTransactionId);
};

export const getLatestAnchorTransaction = (db: AppDatabase) => {
  const row = db
    .prepare(`
      SELECT
        anchor_transaction_id,
        stellar_transaction_id,
        account,
        sep_status,
        product_status,
        amount_in,
        amount_out,
        asset_code,
        raw,
        created_at,
        updated_at
      FROM anchor_transactions
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .get() as
    | {
        anchor_transaction_id: string;
        stellar_transaction_id: string | null;
        account: string;
        sep_status: SepStatus;
        product_status: ProductStatus;
        amount_in: string | null;
        amount_out: string | null;
        asset_code: string | null;
        raw: string;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  return row ?? null;
};

export const insertQuote = (db: AppDatabase, quote: PrefundingQuote): void => {
  const now = nowIso();
  db.prepare(`
    INSERT INTO quotes
      (id, anchor_transaction_id, account, collateral_token, requested_credit_amount, tenor_days,
       oracle_price_e7, oracle_updated_ledger, haircut_bps, max_tenor_days, fee_bps, fee_amount,
       expires_at, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    quote.id,
    quote.anchorTransactionId,
    quote.account,
    quote.collateralToken,
    quote.requestedCreditAmount,
    quote.tenorDays,
    quote.oraclePriceE7,
    quote.oracleUpdatedLedger,
    quote.haircutBps,
    quote.maxTenorDays,
    quote.feeBps,
    quote.feeAmount,
    quote.expiresAt,
    quote.source,
    now,
    now
  );
};

export const getLatestQuoteId = (db: AppDatabase): string | null => {
  const row = db.prepare("SELECT id FROM quotes ORDER BY created_at DESC LIMIT 1").get() as
    | { id: string }
    | undefined;
  return row?.id ?? null;
};

const mapQuoteRow = (row: {
  id: string;
  anchor_transaction_id: string | null;
  account: string;
  collateral_token: string;
  requested_credit_amount: string;
  tenor_days: number;
  oracle_price_e7: string;
  oracle_updated_ledger: number | null;
  haircut_bps: number;
  max_tenor_days: number;
  fee_bps: number;
  fee_amount: string;
  expires_at: string;
  source: "chain";
}): PrefundingQuote => ({
  id: row.id,
  anchorTransactionId: row.anchor_transaction_id,
  account: row.account,
  collateralToken: row.collateral_token,
  requestedCreditAmount: row.requested_credit_amount,
  tenorDays: row.tenor_days,
  participantApproved: true,
  oraclePriceE7: row.oracle_price_e7,
  oracleUpdatedLedger: row.oracle_updated_ledger,
  haircutBps: row.haircut_bps,
  maxTenorDays: row.max_tenor_days,
  feeBps: row.fee_bps,
  feeAmount: row.fee_amount,
  expiresAt: row.expires_at,
  source: row.source
});

export const getQuoteById = (db: AppDatabase, id: string): PrefundingQuote | null => {
  const row = db.prepare("SELECT * FROM quotes WHERE id = ?").get(id) as
    | Parameters<typeof mapQuoteRow>[0]
    | undefined;
  return row ? mapQuoteRow(row) : null;
};

export const getLatestQuote = (db: AppDatabase): PrefundingQuote | null => {
  const row = db.prepare("SELECT * FROM quotes ORDER BY created_at DESC LIMIT 1").get() as
    | Parameters<typeof mapQuoteRow>[0]
    | undefined;
  return row ? mapQuoteRow(row) : null;
};

export const insertProofJob = (
  db: AppDatabase,
  job: ProofJob
): void => {
  db.prepare(`
    INSERT INTO proof_jobs (id, type, status, payload, result, error, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id,
    job.type,
    job.status,
    JSON.stringify(job.payload),
    job.result ? JSON.stringify(job.result) : null,
    job.error,
    job.attempts,
    job.createdAt,
    job.updatedAt
  );
};

export const getProofJob = <TPayload = unknown, TResult = unknown>(
  db: AppDatabase,
  id: string
): ProofJob<TPayload, TResult> | null => {
  const row = db.prepare("SELECT * FROM proof_jobs WHERE id = ?").get(id) as
    | {
        id: string;
        type: ProofJobType;
        status: ProofJobStatus;
        payload: string;
        result: string | null;
        error: string | null;
        attempts: number;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  return row
    ? {
        id: row.id,
        type: row.type,
        status: row.status,
        payload: parseJson<TPayload>(row.payload),
        result: row.result ? parseJson<TResult>(row.result) : null,
        error: row.error,
        attempts: row.attempts,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    : null;
};

export const claimNextProofJob = (db: AppDatabase): ProofJob | null => {
  const row = db
    .prepare("SELECT id FROM proof_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1")
    .get() as { id: string } | undefined;
  if (!row) return null;
  const now = nowIso();
  db.prepare("UPDATE proof_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?")
    .run(now, row.id);
  return getProofJob(db, row.id);
};

export const completeProofJob = (
  db: AppDatabase,
  id: string,
  status: "succeeded" | "failed",
  result: unknown,
  error?: string | null
): void => {
  db.prepare("UPDATE proof_jobs SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?").run(
    status,
    result ? JSON.stringify(result) : null,
    error ?? null,
    nowIso(),
    id
  );
};

export const getLatestProofJobId = (db: AppDatabase): string | null => {
  const row = db.prepare("SELECT id FROM proof_jobs ORDER BY created_at DESC LIMIT 1").get() as
    | { id: string }
    | undefined;
  return row?.id ?? null;
};

export const insertContractEvent = (
  db: AppDatabase,
  event: {
    id: string;
    contractId: string;
    eventName: string;
    ledger?: number | null;
    pagingToken?: string | null;
    txHash?: string | null;
    payload: unknown;
  }
): boolean => {
  const result = db.prepare(`
    INSERT OR IGNORE INTO contract_events
      (id, contract_id, event_name, ledger, paging_token, tx_hash, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.contractId,
    event.eventName,
    event.ledger ?? null,
    event.pagingToken ?? null,
    event.txHash ?? null,
    JSON.stringify(event.payload),
    nowIso()
  );
  return result.changes > 0;
};

export type ConfidentialTransferEvidence = {
  id: string;
  anchorTransactionId: string | null;
  positionId: string;
  direction: "draw" | "repayment";
  tokenContractId: string;
  method: "confidential_transfer" | "confidential_transfer_from";
  signer: string;
  spender: string | null;
  fromAccount: string;
  toAccount: string;
  transferCommitment: string | null;
  txHash: string;
  ledger: number | null;
  auditorPayload: Record<string, unknown> | null;
  eventPayload: Record<string, unknown>;
  dataXdrSha256: string;
  dataXdrBase64: string | null;
  createdAt: string;
};

const mapConfidentialTransferEvidence = (row: {
  id: string;
  anchor_transaction_id: string | null;
  position_id: string;
  direction: "draw" | "repayment";
  token_contract_id: string;
  method: "confidential_transfer" | "confidential_transfer_from";
  signer: string;
  spender: string | null;
  from_account: string;
  to_account: string;
  transfer_commitment: string | null;
  tx_hash: string;
  ledger: number | null;
  auditor_payload: string | null;
  event_payload: string;
  data_xdr_sha256: string;
  data_xdr_base64: string | null;
  created_at: string;
}): ConfidentialTransferEvidence => ({
  id: row.id,
  anchorTransactionId: row.anchor_transaction_id,
  positionId: row.position_id,
  direction: row.direction,
  tokenContractId: row.token_contract_id,
  method: row.method,
  signer: row.signer,
  spender: row.spender,
  fromAccount: row.from_account,
  toAccount: row.to_account,
  transferCommitment: row.transfer_commitment,
  txHash: row.tx_hash,
  ledger: row.ledger,
  auditorPayload: row.auditor_payload ? parseJson<Record<string, unknown>>(row.auditor_payload) : null,
  eventPayload: parseJson<Record<string, unknown>>(row.event_payload),
  dataXdrSha256: row.data_xdr_sha256,
  dataXdrBase64: row.data_xdr_base64,
  createdAt: row.created_at
});

export const insertConfidentialTransferEvidence = (
  db: AppDatabase,
  evidence: Omit<ConfidentialTransferEvidence, "createdAt">
): void => {
  db.prepare(`
    INSERT INTO confidential_transfer_evidence
      (id, anchor_transaction_id, position_id, direction, token_contract_id, method, signer,
       spender, from_account, to_account, transfer_commitment, tx_hash, ledger, auditor_payload,
       event_payload, data_xdr_sha256, data_xdr_base64, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    evidence.id,
    evidence.anchorTransactionId,
    evidence.positionId,
    evidence.direction,
    evidence.tokenContractId,
    evidence.method,
    evidence.signer,
    evidence.spender,
    evidence.fromAccount,
    evidence.toAccount,
    evidence.transferCommitment,
    evidence.txHash,
    evidence.ledger,
    evidence.auditorPayload ? JSON.stringify(evidence.auditorPayload) : null,
    JSON.stringify(evidence.eventPayload),
    evidence.dataXdrSha256,
    evidence.dataXdrBase64,
    nowIso()
  );
};

export const getConfidentialTransferEvidenceById = (
  db: AppDatabase,
  id: string
): ConfidentialTransferEvidence | null => {
  const row = db
    .prepare("SELECT * FROM confidential_transfer_evidence WHERE id = ?")
    .get(id) as Parameters<typeof mapConfidentialTransferEvidence>[0] | undefined;
  return row ? mapConfidentialTransferEvidence(row) : null;
};

export const updateConfidentialTransferEvidence = (
  db: AppDatabase,
  id: string,
  patch: {
    auditorPayload?: Record<string, unknown> | null;
    eventPayload?: Record<string, unknown>;
    dataXdrBase64?: string | null;
  }
): ConfidentialTransferEvidence | null => {
  const current = getConfidentialTransferEvidenceById(db, id);
  if (!current) return null;
  const auditorPayload =
    patch.auditorPayload !== undefined ? patch.auditorPayload : current.auditorPayload;
  const eventPayload = patch.eventPayload ?? current.eventPayload;
  const dataXdrBase64 =
    patch.dataXdrBase64 !== undefined ? patch.dataXdrBase64 : current.dataXdrBase64;
  db.prepare(`
    UPDATE confidential_transfer_evidence
    SET auditor_payload = ?, event_payload = ?, data_xdr_base64 = ?
    WHERE id = ?
  `).run(auditorPayload ? JSON.stringify(auditorPayload) : null, JSON.stringify(eventPayload), dataXdrBase64, id);
  return getConfidentialTransferEvidenceById(db, id);
};

export const listConfidentialTransferEvidence = (
  db: AppDatabase,
  input: { positionId?: string; anchorTransactionId?: string; limit?: number } = {}
): ConfidentialTransferEvidence[] => {
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.positionId) {
    clauses.push("position_id = ?");
    params.push(input.positionId);
  }
  if (input.anchorTransactionId) {
    clauses.push("anchor_transaction_id = ?");
    params.push(input.anchorTransactionId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`
      SELECT * FROM confidential_transfer_evidence
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(...params, limit) as Parameters<typeof mapConfidentialTransferEvidence>[0][];
  return rows.map(mapConfidentialTransferEvidence);
};

export const getLatestConfidentialTransferEvidence = (
  db: AppDatabase
): ConfidentialTransferEvidence | null => {
  const row = db
    .prepare("SELECT * FROM confidential_transfer_evidence ORDER BY created_at DESC LIMIT 1")
    .get() as Parameters<typeof mapConfidentialTransferEvidence>[0] | undefined;
  return row ? mapConfidentialTransferEvidence(row) : null;
};

export const insertRepaymentLeaf = (
  db: AppDatabase,
  leaf: Omit<RepaymentLeafRecord, "createdAt">
): void => {
  db.prepare(`
    INSERT OR IGNORE INTO repayment_leaves
      (id, position_id, leaf_nullifier, repayment_commitment, paid_ledger, due_ledger,
       on_time, tx_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    leaf.id,
    leaf.positionId,
    leaf.leafNullifier,
    leaf.repaymentCommitment,
    leaf.paidLedger,
    leaf.dueLedger,
    leaf.onTime ? 1 : 0,
    leaf.txHash ?? null,
    nowIso()
  );
};

export const insertDisclosureBundle = (
  db: AppDatabase,
  bundle: Omit<DisclosureBundleRecord, "createdAt" | "updatedAt">
): void => {
  const now = nowIso();
  db.prepare(`
    INSERT INTO disclosure_bundles
      (id, grant_id, owner, viewer_hash, position_id, event_hash, scope_hash, bundle_hash,
       ciphertext, nonce, auth_tag, algorithm, on_chain_tx_hash, revoked, expires_at_ledger,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    bundle.id,
    bundle.grantId,
    bundle.owner,
    bundle.viewerHash,
    bundle.positionId,
    bundle.eventHash,
    bundle.scopeHash,
    bundle.bundleHash,
    bundle.ciphertext,
    bundle.nonce,
    bundle.authTag,
    bundle.algorithm,
    bundle.onChainTxHash ?? null,
    bundle.revoked ? 1 : 0,
    bundle.expiresAtLedger,
    now,
    now
  );
};

export const updateDisclosureBundleOnChainTx = (
  db: AppDatabase,
  grantId: string,
  txHash: string | null
): void => {
  db.prepare(`
    UPDATE disclosure_bundles
    SET on_chain_tx_hash = ?, updated_at = ?
    WHERE grant_id = ?
  `).run(txHash, nowIso(), grantId);
};

export const markDisclosureBundleRevoked = (db: AppDatabase, grantId: string): void => {
  db.prepare(`
    UPDATE disclosure_bundles
    SET revoked = 1, updated_at = ?
    WHERE grant_id = ?
  `).run(nowIso(), grantId);
};

export const getDisclosureBundle = (
  db: AppDatabase,
  grantId: string
): DisclosureBundleRecord | null => {
  const row = db.prepare("SELECT * FROM disclosure_bundles WHERE grant_id = ?").get(grantId) as
    | {
        id: string;
        grant_id: string;
        owner: string;
        viewer_hash: string;
        position_id: string;
        event_hash: string;
        scope_hash: string;
        bundle_hash: string;
        ciphertext: string;
        nonce: string;
        auth_tag: string;
        algorithm: string;
        on_chain_tx_hash: string | null;
        revoked: number;
        expires_at_ledger: number;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  return row
    ? {
        id: row.id,
        grantId: row.grant_id,
        owner: row.owner,
        viewerHash: row.viewer_hash,
        positionId: row.position_id,
        eventHash: row.event_hash,
        scopeHash: row.scope_hash,
        bundleHash: row.bundle_hash,
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.auth_tag,
        algorithm: "aes-256-gcm",
        onChainTxHash: row.on_chain_tx_hash,
        revoked: Boolean(row.revoked),
        expiresAtLedger: row.expires_at_ledger,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    : null;
};

export const getLatestDisclosureGrantId = (db: AppDatabase): string | null => {
  const row = db
    .prepare("SELECT grant_id FROM disclosure_bundles ORDER BY created_at DESC LIMIT 1")
    .get() as { grant_id: string } | undefined;
  return row?.grant_id ?? null;
};
