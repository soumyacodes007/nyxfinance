import type { RepaymentHistoryProofPayload, RepaymentHistoryProofResult } from "./repayment-history.js";

export type ProofJobType = "collateral_sufficiency" | "repayment_history";
export type ProofJobStatus = "queued" | "running" | "succeeded" | "failed";

export type CollateralSufficiencyProofPayload = {
  quoteId?: string;
  collateralAmount: string;
  collateralRandomness: string;
  creditAmount: string;
  creditRandomness: string;
  positionSecret: string;
  collateralCommitmentX: string;
  collateralCommitmentY: string;
  creditCommitmentX: string;
  creditCommitmentY: string;
  lockKey: string;
  positionNullifier: string;
  oraclePriceE7: string;
  haircutBps: number;
  tenorDays: number;
};

export type CollateralSufficiencyProofResult = {
  proofHex: string;
  publicInputsHex: string;
  artifactsDir: string;
};

export type { RepaymentHistoryProofPayload, RepaymentHistoryProofResult };

export type ProofJob<TPayload = unknown, TResult = unknown> = {
  id: string;
  type: ProofJobType;
  status: ProofJobStatus;
  payload: TPayload;
  result: TResult | null;
  error: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};
