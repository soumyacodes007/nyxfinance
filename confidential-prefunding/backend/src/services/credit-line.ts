import * as StellarSdk from "@stellar/stellar-sdk";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import { updateProductStatus } from "../db/sqlite.js";
import { buildRpcServer } from "./stellar-rpc.js";
import type {
  CreditLineTxResult,
  DrawCreditInput,
  OpenCreditInput,
  RepayCreditInput
} from "../types/credit-line.js";

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

const submitContractCall = async (
  config: AppConfig,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<CreditLineTxResult> => {
  const contractId = config.contracts.prefundingCreditLine;
  if (!contractId) throw new Error("PREFUNDING_CREDIT_LINE_CONTRACT_ID is not configured");

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
  const result = await submitContractCall(config, "execute_draw", [
    bytes32Arg(input.positionId, "positionId"),
    addressArg(input.facility),
    bytes32Arg(input.transferCommitment, "transferCommitment"),
    addressArg(operator.publicKey())
  ]);
  if (input.anchorTransactionId) updateProductStatus(db, input.anchorTransactionId, "credit_drawn");
  return result;
};

export const repayCreditLine = async (
  config: AppConfig,
  db: AppDatabase,
  input: RepayCreditInput
): Promise<CreditLineTxResult> => {
  const operator = getOperator(config);
  const result = await submitContractCall(config, "repay", [
    bytes32Arg(input.positionId, "positionId"),
    bytes32Arg(input.repaymentCommitment, "repaymentCommitment"),
    addressArg(operator.publicKey())
  ]);
  if (input.anchorTransactionId) updateProductStatus(db, input.anchorTransactionId, "repaid");
  return result;
};
