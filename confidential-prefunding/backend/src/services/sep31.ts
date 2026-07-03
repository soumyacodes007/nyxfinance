import type { AppDatabase } from "../db/sqlite.js";
import {
  getAnchorTransactionById,
  parseJson,
  updateSepStatus,
  upsertAnchorTransaction
} from "../db/sqlite.js";
import { newId } from "../lib/ids.js";
import type { AppConfig } from "../lib/env.js";
import type { ProductStatus, SepStatus } from "../types/status.js";
import { normalizeProductStatus, normalizeSepStatus } from "./anchor-platform.js";

export type Sep31TransactionInput = {
  id?: string;
  transaction_id?: string;
  anchor_transaction_id?: string;
  account?: string;
  from?: string;
  sender_id?: string;
  receiver_id?: string;
  status?: string;
  stellar_transaction_id?: string | null;
  amount_in?: string | number | null;
  amount_out?: string | number | null;
  asset_code?: string | null;
  quote_id?: string | null;
  fields?: Record<string, unknown>;
};

const stringOrNull = (value: unknown): string | null => {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number") return String(value);
  return null;
};

const recordOrEmpty = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const buildMoreInfoUrl = (config: AppConfig, id: string) =>
  `${config.anchorPlatformPublicUrl.replace(/\/$/, "")}/sep31/transaction/${encodeURIComponent(id)}`;

const mapRow = (config: AppConfig, row: NonNullable<ReturnType<typeof getAnchorTransactionById>>) => {
  const raw = parseJson<Record<string, unknown>>(row.raw);
  const fields = recordOrEmpty(raw.fields);
  const corridor = stringOrNull(fields.corridor ?? raw.corridor);
  const settlementWindowDays = stringOrNull(fields.settlement_window_days ?? raw.settlement_window_days);
  return {
    id: row.anchor_transaction_id,
    transaction_id: row.anchor_transaction_id,
    status: row.sep_status,
    status_eta: raw.status_eta ?? 3600,
    more_info_url: typeof raw.more_info_url === "string" ? raw.more_info_url : buildMoreInfoUrl(config, row.anchor_transaction_id),
    stellar_transaction_id: row.stellar_transaction_id,
    amount_in: row.amount_in,
    amount_out: row.amount_out,
    asset_code: row.asset_code,
    product_status: row.product_status,
    sender_id: raw.sender_id ?? row.account,
    receiver_id: raw.receiver_id ?? null,
    quote_id: raw.quote_id ?? null,
    fields,
    corridor,
    settlement_window_days: settlementWindowDays ? Number(settlementWindowDays) : null,
    started_at: row.created_at,
    updated_at: row.updated_at,
    refunds: raw.refunds ?? null
  };
};

export const createSep31Transaction = (
  config: AppConfig,
  db: AppDatabase,
  input: Sep31TransactionInput
) => {
  const anchorTransactionId = String(
    input.id ?? input.transaction_id ?? input.anchor_transaction_id ?? newId("sep31")
  );
  const account = String(input.account ?? input.from ?? input.sender_id ?? "unknown");
  const sepStatus = normalizeSepStatus(input.status ?? "pending_sender");
  const existing = getAnchorTransactionById(db, anchorTransactionId);
  const normalizedProductStatus = normalizeProductStatus(sepStatus);
  const productStatus: ProductStatus = existing?.product_status ?? normalizedProductStatus;
  const raw = {
    protocol: "SEP-31",
    ...input,
    id: anchorTransactionId,
    account,
    status: sepStatus,
    product_status: productStatus,
    more_info_url: buildMoreInfoUrl(config, anchorTransactionId)
  };

  upsertAnchorTransaction(db, {
    id: existing?.id ?? newId("tx"),
    anchorTransactionId,
    stellarTransactionId: input.stellar_transaction_id ?? null,
    account,
    sepStatus,
    productStatus,
    amountIn: stringOrNull(input.amount_in),
    amountOut: stringOrNull(input.amount_out),
    assetCode: stringOrNull(input.asset_code),
    raw
  });

  const row = getAnchorTransactionById(db, anchorTransactionId);
  if (!row) throw new Error("failed to persist SEP-31 transaction");
  return mapRow(config, row);
};

export const getSep31Transaction = (config: AppConfig, db: AppDatabase, id: string) => {
  const row = getAnchorTransactionById(db, id);
  if (!row) {
    const error = new Error(`SEP-31 transaction not found: ${id}`);
    (error as Error & { statusCode?: number }).statusCode = 404;
    throw error;
  }
  return mapRow(config, row);
};

export const updateSep31TransactionStatus = (
  config: AppConfig,
  db: AppDatabase,
  id: string,
  status: string,
  rawUpdate: Record<string, unknown> = {}
) => {
  const existing = getAnchorTransactionById(db, id);
  if (!existing) {
    const error = new Error(`SEP-31 transaction not found: ${id}`);
    (error as Error & { statusCode?: number }).statusCode = 404;
    throw error;
  }
  const sepStatus = normalizeSepStatus(status);
  const raw = {
    ...parseJson<Record<string, unknown>>(existing.raw),
    ...rawUpdate,
    status: sepStatus,
    updated_via: "SEP-31"
  };
  const stellarTransactionId =
    typeof rawUpdate.stellar_transaction_id === "string" ? rawUpdate.stellar_transaction_id : null;
  updateSepStatus(db, id, sepStatus, raw, stellarTransactionId);
  return getSep31Transaction(config, db, id);
};

export const markSep31PaymentSubmitted = (
  config: AppConfig,
  db: AppDatabase,
  id: string,
  rawUpdate: Record<string, unknown> = {}
) =>
  updateSep31TransactionStatus(config, db, id, "pending_stellar", {
    ...rawUpdate,
    action: "payment_submitted"
  });

export const markSep31Completed = (
  config: AppConfig,
  db: AppDatabase,
  id: string,
  rawUpdate: Record<string, unknown> = {}
) =>
  updateSep31TransactionStatus(config, db, id, "completed", {
    ...rawUpdate,
    action: "settlement_completed"
  });
