import { createHash } from "node:crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import type { AppDatabase } from "../db/sqlite.js";
import { insertConfidentialTransferEvidence } from "../db/sqlite.js";
import type { AppConfig } from "../lib/env.js";
import { newId } from "../lib/ids.js";
import type {
  ConfidentialTransferMethod,
  ConfidentialTransferRequest,
  ConfidentialTransferResult
} from "../types/credit-line.js";
import {
  keypairFromSecret,
  submitContractCallWithKeypair
} from "./operator-tx.js";
import { rpcRequest } from "./stellar-rpc.js";

const addressArg = (address: string): StellarSdk.xdr.ScVal =>
  StellarSdk.Address.fromString(address).toScVal();

const decodeDataXdr = (value: string): Buffer => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const data = Buffer.from(normalized, "base64");
  if (data.length === 0) throw new Error("confidential transfer dataXdrBase64 is empty");
  return data;
};

const bytesArg = (data: Buffer): StellarSdk.xdr.ScVal =>
  StellarSdk.nativeToScVal(data, { type: "bytes" });

const sha256Hex = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

type RpcEvent = {
  contractId?: string;
  contract_id?: string;
  topics?: string[];
  topic?: string[];
  value?: string;
  txHash?: string;
  tx_hash?: string;
};

const decodeScVal = (value: string): unknown =>
  StellarSdk.scValToNative(StellarSdk.xdr.ScVal.fromXDR(value, "base64"));

const decodeTopic = (topic: string): string | null => {
  try {
    const native = decodeScVal(topic);
    return typeof native === "string" ? native : null;
  } catch {
    return null;
  }
};

const bytesLikeToHex = (value: unknown): string | null => {
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  if (typeof value === "string" && /^(0x)?[0-9a-fA-F]+$/.test(value)) {
    return value.replace(/^0x/, "");
  }
  return null;
};

const decodeEventValue = (
  eventName: "transfer" | "spender_transfer",
  value?: string
): Record<string, unknown> | null => {
  if (!value) return null;
  const native = decodeScVal(value);
  if (!Array.isArray(native)) return null;
  const fields =
    eventName === "spender_transfer"
      ? ["r_e", "v_tilde", "sigma_a", "v_aud_r", "r_aud_r", "v_aud_s", "a_aud_s"]
      : ["r_e", "v_tilde", "sigma", "b_tilde", "v_aud_r", "r_aud_r", "v_aud_s", "b_aud_s"];
  return Object.fromEntries(
    fields
      .map((field, index) => [field, bytesLikeToHex(native[index])])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
};

export const fetchEmittedConfidentialEventPayload = async (
  config: AppConfig,
  input: {
    tokenContractId: string;
    txHash: string;
    ledger?: number;
    eventName: "transfer" | "spender_transfer";
  }
): Promise<Record<string, unknown> | null> => {
  if (!input.ledger) return null;
  const result = await rpcRequest<{ events?: RpcEvent[] }>(config.stellarRpcUrl, "getEvents", {
    startLedger: Math.max(1, input.ledger - 1),
    filters: [{ type: "contract", contractIds: [input.tokenContractId] }],
    limit: 50
  });
  const event = (result.events ?? []).find((candidate) => {
    const txHash = candidate.txHash ?? candidate.tx_hash;
    const contractId = candidate.contractId ?? candidate.contract_id;
    const topics = candidate.topics ?? candidate.topic ?? [];
    return (
      txHash === input.txHash &&
      contractId === input.tokenContractId &&
      topics.some((topic) => decodeTopic(topic) === input.eventName)
    );
  });
  return event ? decodeEventValue(input.eventName, event.value) : null;
};

// Consolidates `receiving_balance` into `spendable_balance` for a
// confidential account. The repayment transfer proof is built assuming this
// has already happened (e.g. draw funds landed in receiving_balance and must
// be merged before the anchor can spend them back out), so this stays a
// separate preceding transaction rather than folding into the atomic
// repay() call -- it's a balance-housekeeping step, not part of the
// draw/repay trust boundary K9-adjacent fix addresses.
export const mergeConfidentialBalance = async (
  config: AppConfig,
  tokenContractId: string,
  accountSecretKey: string
): Promise<{ hash: string; ledger?: number }> => {
  const signer = keypairFromSecret(accountSecretKey, "accountSecretKey");
  return submitContractCallWithKeypair(config, signer, tokenContractId, "merge", [addressArg(signer.publicKey())]);
};

const resolveSigner = (
  config: AppConfig,
  method: "confidential_transfer" | "confidential_transfer_from",
  request: ConfidentialTransferRequest
): { signer: StellarSdk.Keypair; spender: string | null } => {
  if (method === "confidential_transfer_from") {
    const signer = keypairFromSecret(config.creditExecutorSecretKey, "CREDIT_EXECUTOR_SECRET_KEY");
    const spender = request.spender ?? signer.publicKey();
    if (spender !== signer.publicKey()) {
      throw new Error("confidential_transfer_from spender must match CREDIT_EXECUTOR_SECRET_KEY public key");
    }
    return { signer, spender };
  }

  const signer = keypairFromSecret(
    request.signerSecretKey ?? config.demoAnchorSecretKey,
    request.signerSecretKey ? "profile signerSecretKey" : "DEMO_ANCHOR_SECRET_KEY"
  );
  if (request.from !== signer.publicKey()) {
    throw new Error("confidential_transfer signer must match the from account");
  }
  return { signer, spender: null };
};

// Records evidence for a confidential transfer that already happened as a
// NESTED cross-contract call inside another transaction (execute_draw's
// confidential_transfer_from, repay's confidential_transfer) rather than as
// its own top-level submission. The token contract still emits the same
// transfer/spender_transfer event, just under the outer call's tx hash, so
// event-fetching works unchanged.
export const recordConfidentialTransferEvidence = async (
  config: AppConfig,
  db: AppDatabase,
  input: {
    anchorTransactionId?: string;
    positionId: string;
    direction: "draw" | "repayment";
    transferCommitment?: string;
    tokenContractId: string;
    method: ConfidentialTransferMethod;
    signer: string;
    spender: string | null;
    from: string;
    to: string;
    dataXdrBase64: string;
    txHash: string;
    ledger?: number;
    auditorPayload?: Record<string, unknown>;
    eventPayload?: Record<string, unknown>;
  }
): Promise<ConfidentialTransferResult> => {
  const data = decodeDataXdr(input.dataXdrBase64);
  const dataXdrSha256 = sha256Hex(data);
  const eventName = input.method === "confidential_transfer_from" ? "spender_transfer" : "transfer";
  const emittedPayload = await fetchEmittedConfidentialEventPayload(config, {
    tokenContractId: input.tokenContractId,
    txHash: input.txHash,
    ledger: input.ledger,
    eventName
  }).catch((error) => ({
    emittedEventFetchError: error instanceof Error ? error.message : String(error)
  }));
  const eventPayload = {
    eventName,
    tokenContractId: input.tokenContractId,
    method: input.method,
    txHash: input.txHash,
    ledger: input.ledger,
    from: input.from,
    to: input.to,
    spender: input.spender,
    dataXdrSha256,
    ...(emittedPayload ?? {}),
    ...(input.eventPayload ?? {})
  };

  insertConfidentialTransferEvidence(db, {
    id: newId("ctf"),
    anchorTransactionId: input.anchorTransactionId ?? null,
    positionId: input.positionId,
    direction: input.direction,
    tokenContractId: input.tokenContractId,
    method: input.method,
    signer: input.signer,
    spender: input.spender,
    fromAccount: input.from,
    toAccount: input.to,
    transferCommitment: input.transferCommitment ?? null,
    txHash: input.txHash,
    ledger: input.ledger ?? null,
    auditorPayload: input.auditorPayload ?? null,
    eventPayload,
    dataXdrSha256,
    dataXdrBase64: input.dataXdrBase64
  });

  return {
    tokenContractId: input.tokenContractId,
    method: input.method,
    signer: input.signer,
    spender: input.spender,
    from: input.from,
    to: input.to,
    txHash: input.txHash,
    ledger: input.ledger,
    dataXdrSha256,
    dataXdrBase64: input.dataXdrBase64,
    auditorPayloadRef: input.auditorPayload ? "live_ciphertext" : "not_provided"
  };
};

export const submitAndRecordConfidentialTransfer = async (
  config: AppConfig,
  db: AppDatabase,
  input: {
    anchorTransactionId?: string;
    positionId: string;
    direction: "draw" | "repayment";
    transferCommitment?: string;
    request: ConfidentialTransferRequest;
  }
): Promise<ConfidentialTransferResult> => {
  const method = input.request.method ?? "confidential_transfer_from";
  const tokenContractId = input.request.tokenContractId ?? config.contracts.confidentialCusdc;
  if (!tokenContractId) {
    throw new Error("CONFIDENTIAL_CUSDC_CONTRACT_ID is not configured");
  }

  const { signer, spender } = resolveSigner(config, method, input.request);
  const data = decodeDataXdr(input.request.dataXdrBase64);
  const dataXdrSha256 = sha256Hex(data);
  const args =
    method === "confidential_transfer_from"
      ? [
          addressArg(spender ?? signer.publicKey()),
          addressArg(input.request.from),
          addressArg(input.request.to),
          bytesArg(data)
        ]
      : [addressArg(input.request.from), addressArg(input.request.to), bytesArg(data)];

  const mergeTx =
    method === "confidential_transfer" && input.request.mergeBeforeTransfer
      ? await submitContractCallWithKeypair(config, signer, tokenContractId, "merge", [
          addressArg(input.request.from)
        ])
      : null;
  const tx = await submitContractCallWithKeypair(config, signer, tokenContractId, method, args);
  const eventName = method === "confidential_transfer_from" ? "spender_transfer" : "transfer";
  const emittedPayload = await fetchEmittedConfidentialEventPayload(config, {
    tokenContractId,
    txHash: tx.hash,
    ledger: tx.ledger,
    eventName
  }).catch((error) => ({
    emittedEventFetchError: error instanceof Error ? error.message : String(error)
  }));
  const eventPayload = {
    eventName,
    tokenContractId,
    method,
    txHash: tx.hash,
    ledger: tx.ledger,
    from: input.request.from,
    to: input.request.to,
    spender,
    dataXdrSha256,
    ...(mergeTx ? { mergeTxHash: mergeTx.hash, mergeLedger: mergeTx.ledger } : {}),
    ...(emittedPayload ?? {}),
    ...(input.request.eventPayload ?? {})
  };

  insertConfidentialTransferEvidence(db, {
    id: newId("ctf"),
    anchorTransactionId: input.anchorTransactionId ?? null,
    positionId: input.positionId,
    direction: input.direction,
    tokenContractId,
    method,
    signer: signer.publicKey(),
    spender,
    fromAccount: input.request.from,
    toAccount: input.request.to,
    transferCommitment: input.transferCommitment ?? null,
    txHash: tx.hash,
    ledger: tx.ledger ?? null,
    auditorPayload: input.request.auditorPayload ?? null,
    eventPayload,
    dataXdrSha256,
    dataXdrBase64: input.request.dataXdrBase64
  });

  return {
    tokenContractId,
    method,
    signer: signer.publicKey(),
    spender,
    from: input.request.from,
    to: input.request.to,
    txHash: tx.hash,
    ledger: tx.ledger,
    dataXdrSha256,
    dataXdrBase64: input.request.dataXdrBase64,
    auditorPayloadRef: input.request.auditorPayload ? "live_ciphertext" : "not_provided"
  };
};
