export type CreditLineTxResult = {
  hash: string;
  ledger?: number;
};

export type OpenCreditInput = {
  anchorTransactionId?: string;
  positionId: string;
  anchor: string;
  collateralToken?: string;
  lockKey: string;
  collateralCommitmentX: string;
  collateralCommitmentY: string;
  creditCommitmentX: string;
  creditCommitmentY: string;
  oraclePriceE7: string;
  haircutBps: number;
  tenorDays: number;
  positionNullifier: string;
  publicInputsHex: string;
  proofHex: string;
};

export type DrawCreditInput = {
  anchorTransactionId?: string;
  positionId: string;
  facility: string;
  transferCommitment: string;
};

export type RepayCreditInput = {
  anchorTransactionId?: string;
  positionId: string;
  repaymentCommitment: string;
};
