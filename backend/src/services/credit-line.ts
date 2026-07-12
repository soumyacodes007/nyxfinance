import * as StellarSdk from "@stellar/stellar-sdk";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import { updateProductStatus } from "../db/sqlite.js";
import { keypairFromSecret, operatorKeypair, submitContractCallWithSigners } from "./operator-tx.js";
import type {
  CreditLineTxResult,
  DrawCreditInput,
  OpenCreditInput,
  RepayCreditInput
} from "../types/credit-line.js";
import { recordConfidentialTransferEvidence } from "./confidential-token-transfer.js";
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

export const openCreditLine = async (
  config: AppConfig,
  db: AppDatabase,
  input: OpenCreditInput
): Promise<CreditLineTxResult> => {
  const operator = getOperator(config);
  const collateralToken = input.collateralToken ?? config.contracts.collateralToken;
  if (!collateralToken) throw new Error("COLLATERAL_TOKEN_CONTRACT_ID is not configured");
  // K3: the anchor whose collateral backs this position must independently
  // authorize `open_credit` -- the operator's manager-role auth alone is no
  // longer sufficient. The contract also no longer takes
  // collateral-commitment args; it sources them on-chain from the anchor's
  // real `confidential_balance()`.
  if (!input.anchorSecretKey) {
    throw new Error("anchorSecretKey is required: open_credit needs the anchor's own require_auth()");
  }
  const anchor = StellarSdk.Keypair.fromSecret(input.anchorSecretKey);
  if (anchor.publicKey() !== input.anchor) {
    throw new Error("anchorSecretKey does not match the anchor account");
  }

  const contractId = config.contracts.prefundingCreditLine;
  if (!contractId) throw new Error("PREFUNDING_CREDIT_LINE_CONTRACT_ID is not configured");
  const result = await submitContractCallWithSigners(
    config,
    operator,
    [anchor],
    contractId,
    "open_credit",
    [
      bytes32Arg(input.positionId, "positionId"),
      addressArg(input.anchor),
      addressArg(collateralToken),
      bytes32Arg(input.lockKey, "lockKey"),
      bytes32Arg(input.creditCommitmentX, "creditCommitmentX"),
      bytes32Arg(input.creditCommitmentY, "creditCommitmentY"),
      StellarSdk.nativeToScVal(BigInt(input.oraclePriceE7), { type: "u128" }),
      StellarSdk.nativeToScVal(input.haircutBps, { type: "u32" }),
      StellarSdk.nativeToScVal(input.tenorDays, { type: "u32" }),
      bytes32Arg(input.positionNullifier, "positionNullifier"),
      bytesArg(input.publicInputsHex, "publicInputsHex"),
      bytesArg(input.proofHex, "proofHex"),
      addressArg(operator.publicKey())
    ]
  );
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
  const contractId = config.contracts.prefundingCreditLine;
  if (!contractId) throw new Error("PREFUNDING_CREDIT_LINE_CONTRACT_ID is not configured");
  const creditExecutor = keypairFromSecret(input.creditExecutorSecretKey, "creditExecutorSecretKey");
  const tokenContractId = input.confidentialTransfer.tokenContractId ?? config.contracts.confidentialCusdc;
  if (!tokenContractId) throw new Error("CONFIDENTIAL_CUSDC_CONTRACT_ID is not configured");
  const dataBytes = Buffer.from(
    input.confidentialTransfer.dataXdrBase64.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  );
  if (dataBytes.length === 0) throw new Error("draw confidentialTransfer.dataXdrBase64 is empty");

  // Was previously a gap (K9-adjacent, see audit-findings.md): execute_draw
  // only checked the commitment matched the proven credit amount, never that
  // a real transfer happened. Now the transfer itself is a nested
  // cross-contract call inside execute_draw, atomic with marking the
  // position drawn -- credit_executor (the facility's real delegated
  // spender) must co-sign, same multi-party pattern as K3's anchor auth.
  const result = await submitContractCallWithSigners(
    config,
    operator,
    [creditExecutor],
    contractId,
    "execute_draw",
    [
      bytes32Arg(input.positionId, "positionId"),
      addressArg(input.facility),
      addressArg(creditExecutor.publicKey()),
      bytes32Arg(input.transferCommitmentX, "transferCommitmentX"),
      bytes32Arg(input.transferCommitmentY, "transferCommitmentY"),
      StellarSdk.nativeToScVal(dataBytes, { type: "bytes" }),
      addressArg(operator.publicKey())
    ]
  );

  const confidentialTransfer = await recordConfidentialTransferEvidence(config, db, {
    anchorTransactionId: input.anchorTransactionId,
    positionId: input.positionId,
    direction: "draw",
    transferCommitment: input.transferCommitmentX,
    tokenContractId,
    method: "confidential_transfer_from",
    signer: creditExecutor.publicKey(),
    spender: creditExecutor.publicKey(),
    from: input.facility,
    to: input.confidentialTransfer.to,
    dataXdrBase64: input.confidentialTransfer.dataXdrBase64,
    txHash: result.hash,
    ledger: result.ledger,
    auditorPayload: input.confidentialTransfer.auditorPayload,
    eventPayload: input.confidentialTransfer.eventPayload
  });

  if (input.anchorTransactionId) {
    updateProductStatus(db, input.anchorTransactionId, "credit_drawn");
    markSep31PaymentSubmitted(config, db, input.anchorTransactionId, {
      stellar_transaction_id: result.hash,
      c_usdc_transfer_tx_hash: result.hash,
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
  const contractId = config.contracts.prefundingCreditLine;
  if (!contractId) throw new Error("PREFUNDING_CREDIT_LINE_CONTRACT_ID is not configured");
  const anchor = keypairFromSecret(input.anchorSecretKey, "anchorSecretKey");
  const tokenContractId = input.confidentialTransfer.tokenContractId ?? config.contracts.confidentialCusdc;
  if (!tokenContractId) throw new Error("CONFIDENTIAL_CUSDC_CONTRACT_ID is not configured");
  if (input.confidentialTransfer.from !== anchor.publicKey()) {
    throw new Error("repay confidentialTransfer.from must match the anchor");
  }
  const dataBytes = Buffer.from(
    input.confidentialTransfer.dataXdrBase64.replace(/-/g, "+").replace(/_/g, "/"),
    "base64"
  );
  if (dataBytes.length === 0) throw new Error("repay confidentialTransfer.dataXdrBase64 is empty");

  // Was previously a gap: repay() closed the position and unfroze the
  // collateral purely on the operator's say-so that a repayment had been
  // made elsewhere, with no on-chain check. The repayment transfer is now a
  // nested cross-contract call inside repay(), atomic with closing the
  // position -- the anchor must co-sign (same reasoning as K3).
  const result = await submitContractCallWithSigners(
    config,
    operator,
    [anchor],
    contractId,
    "repay",
    [
      bytes32Arg(input.positionId, "positionId"),
      addressArg(input.facility),
      bytes32Arg(input.repaymentCommitment, "repaymentCommitment"),
      StellarSdk.nativeToScVal(dataBytes, { type: "bytes" }),
      addressArg(operator.publicKey())
    ]
  );

  const confidentialTransfer = await recordConfidentialTransferEvidence(config, db, {
    anchorTransactionId: input.anchorTransactionId,
    positionId: input.positionId,
    direction: "repayment",
    transferCommitment: input.repaymentCommitment,
    tokenContractId,
    method: "confidential_transfer",
    signer: anchor.publicKey(),
    spender: null,
    from: anchor.publicKey(),
    to: input.facility,
    dataXdrBase64: input.confidentialTransfer.dataXdrBase64,
    txHash: result.hash,
    ledger: result.ledger,
    auditorPayload: input.confidentialTransfer.auditorPayload,
    eventPayload: input.confidentialTransfer.eventPayload
  });

  if (input.anchorTransactionId) updateProductStatus(db, input.anchorTransactionId, "repaid");
  return {
    ...result,
    confidentialTransfer,
    repaymentRecorded: result
  };
};
