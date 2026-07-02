import * as StellarSdk from "@stellar/stellar-sdk";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import { updateProductStatus } from "../db/sqlite.js";
import { operatorKeypair, submitOperatorContractCall } from "./operator-tx.js";
import type {
  CreditLineTxResult,
  DrawCreditInput,
  OpenCreditInput,
  RepayCreditInput
} from "../types/credit-line.js";
import { submitAndRecordConfidentialTransfer } from "./confidential-token-transfer.js";
import { markSep31PaymentSubmitted } from "./sep31.js";

const normalizeHex = (value: string, field: string): string => {
  const hex = value.startsWith("0x") ? value.slice(2) : value;
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`${field} must be even-length hex`);
  }
  return hex.toLowerCase();
};

const bytesArg = (hex: string, field: string): StellarSdk.xdr.ScVal =>
  StellarSdk.nativeToScVal(Buffer.from(normalizeHex(hex, field), "hex"), { type: "bytes" });

const bytes32Arg = (hex: string, field: string): StellarSdk.xdr.ScVal => {
  const normalized = normalizeHex(hex, field);
  if (normalized.length !== 64) throw new Error(`${field} must be 32 bytes`);
  return bytesArg(normalized, field);
};

const addressArg = (address: string): StellarSdk.xdr.ScVal =>
  StellarSdk.Address.fromString(address).toScVal();

const getOperator = (config: AppConfig): StellarSdk.Keypair => {
  return operatorKeypair(config);
};

const submitContractCall = async (
  config: AppConfig,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<CreditLineTxResult> => {
  const contractId = config.contracts.prefundingCreditLine;
  if (!contractId) throw new Error("PREFUNDING_CREDIT_LINE_CONTRACT_ID is not configured");
  return submitOperatorContractCall(config, contractId, method, args);
};

export const openCreditLine = async (
  config: AppConfig,
  db: AppDatabase,
  input: OpenCreditInput
): Promise<CreditLineTxResult> => {
  const operator = getOperator(config);
  const collateralToken = input.collateralToken ?? config.contracts.collateralToken;
  if (!collateralToken) throw new Error("COLLATERAL_TOKEN_CONTRACT_ID is not configured");

  const result = await submitContractCall(config, "open_credit", [
    bytes32Arg(input.positionId, "positionId"),
    addressArg(input.anchor),
    addressArg(collateralToken),
    bytes32Arg(input.lockKey, "lockKey"),
    bytes32Arg(input.collateralCommitmentX, "collateralCommitmentX"),
    bytes32Arg(input.collateralCommitmentY, "collateralCommitmentY"),
    bytes32Arg(input.creditCommitmentX, "creditCommitmentX"),
    bytes32Arg(input.creditCommitmentY, "creditCommitmentY"),
    StellarSdk.nativeToScVal(BigInt(input.oraclePriceE7), { type: "u128" }),
    StellarSdk.nativeToScVal(input.haircutBps, { type: "u32" }),
    StellarSdk.nativeToScVal(input.tenorDays, { type: "u32" }),
    bytes32Arg(input.positionNullifier, "positionNullifier"),
    bytesArg(input.publicInputsHex, "publicInputsHex"),
    bytesArg(input.proofHex, "proofHex"),
    addressArg(operator.publicKey())
  ]);
  if (input.anchorTransactionId) updateProductStatus(db, input.anchorTransactionId, "proof_verified");
  return result;
};

export const executeDraw = async (
  config: AppConfig,
  db: AppDatabase,
  input: DrawCreditInput
): Promise<CreditLineTxResult> => {
  const operator = getOperator(config);
  if (input.confidentialTransfer.from !== input.facility) {
    throw new Error("draw confidentialTransfer.from must match facility");
  }
  const confidentialTransfer = await submitAndRecordConfidentialTransfer(config, db, {
    anchorTransactionId: input.anchorTransactionId,
    positionId: input.positionId,
    direction: "draw",
    transferCommitment: input.transferCommitment,
    request: input.confidentialTransfer
  });
  const result = await submitContractCall(config, "execute_draw", [
    bytes32Arg(input.positionId, "positionId"),
    addressArg(input.facility),
    bytes32Arg(input.transferCommitment, "transferCommitment"),
    addressArg(operator.publicKey())
  ]);
  if (input.anchorTransactionId) {
    updateProductStatus(db, input.anchorTransactionId, "credit_drawn");
    markSep31PaymentSubmitted(config, db, input.anchorTransactionId, {
      stellar_transaction_id: confidentialTransfer.txHash,
      c_usdc_transfer_tx_hash: confidentialTransfer.txHash,
      draw_recorded_tx_hash: result.hash
    });
  }
  return {
    ...result,
    confidentialTransfer,
    drawRecorded: result
  };
};

export const repayCreditLine = async (
  config: AppConfig,
  db: AppDatabase,
  input: RepayCreditInput
): Promise<CreditLineTxResult> => {
  const operator = getOperator(config);
  const confidentialTransfer = input.confidentialTransfer
    ? await submitAndRecordConfidentialTransfer(config, db, {
        anchorTransactionId: input.anchorTransactionId,
        positionId: input.positionId,
        direction: "repayment",
        transferCommitment: input.repaymentCommitment,
        request: input.confidentialTransfer
      })
    : null;
  if (!confidentialTransfer && config.requireConfidentialRepaymentTransfer) {
    throw new Error("repayment confidential transfer evidence is required");
  }
  const result = await submitContractCall(config, "repay", [
    bytes32Arg(input.positionId, "positionId"),
    bytes32Arg(input.repaymentCommitment, "repaymentCommitment"),
    addressArg(operator.publicKey())
  ]);
  if (input.anchorTransactionId) updateProductStatus(db, input.anchorTransactionId, "repaid");
  return {
    ...result,
    ...(confidentialTransfer ? { confidentialTransfer } : {}),
    repaymentRecorded: result
  };
};
