import * as StellarSdk from "@stellar/stellar-sdk";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import { insertRepaymentLeaf } from "../db/sqlite.js";
import { newId } from "../lib/ids.js";
import { operatorKeypair, submitOperatorContractCall } from "./operator-tx.js";

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

const submitRepaymentCall = async (
  config: AppConfig,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<{ hash: string; ledger: number }> => {
  const contractId = config.contracts.repaymentHistory;
  if (!contractId) throw new Error("REPAYMENT_HISTORY_CONTRACT_ID is not configured");
  return submitOperatorContractCall(config, contractId, method, args);
};

export const seedRepaymentLeaf = async (
  config: AppConfig,
  db: AppDatabase,
  input: {
    positionId: string;
    leafNullifier: string;
    repaymentCommitment: string;
    paidLedger: number;
    dueLedger: number;
  }
) => {
  const tx = await submitRepaymentCall(config, "seed_leaf", [
    bytes32Arg(input.positionId, "positionId"),
    bytes32Arg(input.leafNullifier, "leafNullifier"),
    bytes32Arg(input.repaymentCommitment, "repaymentCommitment"),
    StellarSdk.nativeToScVal(input.paidLedger, { type: "u32" }),
    StellarSdk.nativeToScVal(input.dueLedger, { type: "u32" }),
    addressArg(getOperator(config).publicKey())
  ]);
  insertRepaymentLeaf(db, {
    id: newId("leaf"),
    positionId: normalizeHex(input.positionId, "positionId"),
    leafNullifier: normalizeHex(input.leafNullifier, "leafNullifier"),
    repaymentCommitment: normalizeHex(input.repaymentCommitment, "repaymentCommitment"),
    paidLedger: input.paidLedger,
    dueLedger: input.dueLedger,
    onTime: input.paidLedger <= input.dueLedger,
    txHash: tx.hash
  });
  return tx;
};

// The contract derives the history root itself from the leaves already
// seeded via `seed_leaf` (C3 fix) -- it no longer accepts an operator-
// supplied root, so there is nothing left to pass here but the position.
export const setRepaymentHistoryRoot = async (
  config: AppConfig,
  input: { positionId: string }
) =>
  submitRepaymentCall(config, "finalize_history_root", [
    bytes32Arg(input.positionId, "positionId"),
    addressArg(getOperator(config).publicKey())
  ]);

export const verifyRepaymentHistory = async (
  config: AppConfig,
  input: {
    positionId: string;
    threshold: number;
    proofNullifier: string;
    publicInputsHex: string;
    proofHex: string;
  }
) =>
  submitRepaymentCall(config, "verify_history", [
    bytes32Arg(input.positionId, "positionId"),
    StellarSdk.nativeToScVal(input.threshold, { type: "u32" }),
    bytes32Arg(input.proofNullifier, "proofNullifier"),
    bytesArg(input.publicInputsHex, "publicInputsHex"),
    bytesArg(input.proofHex, "proofHex"),
    addressArg(getOperator(config).publicKey())
  ]);
