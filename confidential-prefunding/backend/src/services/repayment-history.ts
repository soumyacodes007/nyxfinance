import * as StellarSdk from "@stellar/stellar-sdk";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import { insertRepaymentLeaf } from "../db/sqlite.js";
import { newId } from "../lib/ids.js";
import { buildRpcServer } from "./stellar-rpc.js";

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
  if (!config.participantPolicyOperatorSecretKey) {
    throw new Error("PARTICIPANT_POLICY_OPERATOR_SECRET_KEY is not configured");
  }
  return StellarSdk.Keypair.fromSecret(config.participantPolicyOperatorSecretKey);
};

const submitRepaymentCall = async (
  config: AppConfig,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<{ hash: string; ledger: number }> => {
  const contractId = config.contracts.repaymentHistory;
  if (!contractId) throw new Error("REPAYMENT_HISTORY_CONTRACT_ID is not configured");

  const operator = getOperator(config);
  const rpc = buildRpcServer(config);
  const source = await rpc.getAccount(operator.publicKey());
  const contract = new StellarSdk.Contract(contractId);
  let tx = new StellarSdk.TransactionBuilder(source, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: config.stellarNetworkPassphrase
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(180)
    .build();

  const simulation = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(simulation)) {
    throw new Error(`${method} simulation failed: ${simulation.error}`);
  }
  tx = StellarSdk.rpc.assembleTransaction(tx, simulation).build();
  tx.sign(operator);

  const sent = await rpc.sendTransaction(tx);
  if (sent.status === "ERROR") {
    throw new Error(`${method} send failed: ${sent.errorResult}`);
  }
  let txResult = await rpc.getTransaction(sent.hash);
  for (let i = 0; i < 30 && txResult.status === "NOT_FOUND"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    txResult = await rpc.getTransaction(sent.hash);
  }
  if (txResult.status !== "SUCCESS") {
    throw new Error(`${method} transaction status ${txResult.status}`);
  }
  return { hash: sent.hash, ledger: txResult.ledger };
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

export const setRepaymentHistoryRoot = async (
  config: AppConfig,
  input: { positionId: string; historyRoot: string; leafCount: number }
) =>
  submitRepaymentCall(config, "set_history_root", [
    bytes32Arg(input.positionId, "positionId"),
    bytes32Arg(input.historyRoot, "historyRoot"),
    StellarSdk.nativeToScVal(input.leafCount, { type: "u32" }),
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
