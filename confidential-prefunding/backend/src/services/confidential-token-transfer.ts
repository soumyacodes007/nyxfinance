import { createHash } from "node:crypto";
import * as StellarSdk from "@stellar/stellar-sdk";
import type { AppDatabase } from "../db/sqlite.js";
import { insertConfidentialTransferEvidence } from "../db/sqlite.js";
import type { AppConfig } from "../lib/env.js";
import { newId } from "../lib/ids.js";
import type {
  ConfidentialTransferRequest,
  ConfidentialTransferResult
} from "../types/credit-line.js";
import {
  keypairFromSecret,
  submitContractCallWithKeypair
} from "./operator-tx.js";

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

  const signer = keypairFromSecret(config.demoAnchorSecretKey, "DEMO_ANCHOR_SECRET_KEY");
  if (request.from !== signer.publicKey()) {
    throw new Error("confidential_transfer signer must match the from account");
  }
  return { signer, spender: null };
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

  const tx = await submitContractCallWithKeypair(config, signer, tokenContractId, method, args);
  const eventName = method === "confidential_transfer_from" ? "spender_transfer" : "transfer";
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
    dataXdrSha256
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
    auditorPayloadRef: input.request.auditorPayload ? "live_ciphertext" : "not_provided"
  };
};
