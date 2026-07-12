import type { RepaymentHistoryProofPayload, RepaymentHistoryProofResult } from "./repayment-history.js";

export type ProofJobType = "collateral_sufficiency" | "repayment_history";
export type ProofJobStatus = "queued" | "running" | "succeeded" | "failed";

export type CollateralSufficiencyProofPayload = {
  quoteId?: string;
  // F1/C1 v2: proves ownership of the account being pledged. Private
  // witness -- never returned in any API response, and whoever runs this
  // prover must hold it (same custody question as the anchor's Stellar key).
  sk: string;
  collateralAmount: string;
  collateralRandomness: string;
  creditAmount: string;
  creditRandomness: string;
  positionSecret: string;
  // The anchor's REAL on-chain spendable_balance commitment (c_spend) --
  // must equal what `confidential_balance()` returns, or `open_credit`
  // rejects the proof regardless of whether it verifies.
  collateralCommitmentX: string;
  collateralCommitmentY: string;
  // Y = sk*H, the anchor's spending public key, also read from
  // `confidential_balance()`.
  yX: string;
  yY: string;
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
