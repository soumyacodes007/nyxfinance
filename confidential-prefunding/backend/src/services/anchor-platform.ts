import type { AppConfig } from "../lib/env.js";
import { newId } from "../lib/ids.js";
import type { AppDatabase } from "../db/sqlite.js";
import { getAnchorTransactionById, upsertAnchorTransaction, upsertCustomerStatus } from "../db/sqlite.js";
import type { AnchorCustomerStatusRequest } from "../types/anchor.js";
import type { ProductStatus, SepStatus } from "../types/status.js";
import { syncParticipantPolicy } from "./participant-policy-sync.js";

export const normalizeSepStatus = (value: unknown): SepStatus => {
  const raw = typeof value === "string" ? value : "pending_sender";
  if (
    raw === "pending_sender" ||
    raw === "pending_stellar" ||
    raw === "pending_receiver" ||
    raw === "pending_external" ||
    raw === "completed" ||
    raw === "refunded" ||
    raw === "expired" ||
    raw === "error"
  ) {
    return raw;
  }
  return "pending_sender";
};

export const normalizeProductStatus = (sepStatus: SepStatus): ProductStatus => {
  void sepStatus;
  return "prefunding_required";
};

export const recordAnchorTransactionCallback = (
  db: AppDatabase,
  body: Record<string, unknown>
) => {
  const anchorTransactionId = String(body.id ?? body.transaction_id ?? body.anchor_transaction_id ?? newId("anchor_tx"));
  const account = String(body.account ?? body.from ?? body.sender_id ?? "unknown");
  const sepStatus = normalizeSepStatus(body.status);
  const existing = getAnchorTransactionById(db, anchorTransactionId);
  const normalizedProductStatus = normalizeProductStatus(sepStatus);
  const productStatus = existing?.product_status ?? normalizedProductStatus;
  upsertAnchorTransaction(db, {
    id: newId("tx"),
    anchorTransactionId,
    stellarTransactionId:
      typeof body.stellar_transaction_id === "string" ? body.stellar_transaction_id : null,
    account,
    sepStatus,
    productStatus,
    amountIn: typeof body.amount_in === "string" ? body.amount_in : null,
    amountOut: typeof body.amount_out === "string" ? body.amount_out : null,
    assetCode: typeof body.asset_code === "string" ? body.asset_code : null,
    raw: body
  });

  return { anchorTransactionId, sepStatus, productStatus };
};

export const recordCustomerStatus = async (
  config: AppConfig,
  db: AppDatabase,
  input: AnchorCustomerStatusRequest
) => {
  upsertCustomerStatus(db, {
    customerId: input.customerId,
    account: input.account,
    status: input.status,
    memo: input.memo ?? null,
    reason: input.reason ?? null,
    raw: input.raw ?? input
  });

  const sync =
    input.status === "accepted" || input.status === "rejected"
      ? await syncParticipantPolicy(config, input.account, input.status === "accepted")
      : { synced: false as const, reason: "KYB status does not require on-chain sync" };

  return {
    customerId: input.customerId,
    account: input.account,
    kybStatus: input.status,
    participantPolicy: sync
  };
};
