export type RepaymentLeafRecord = {
  id: string;
  positionId: string;
  leafNullifier: string;
  repaymentCommitment: string;
  paidLedger: number;
  dueLedger: number;
  onTime: boolean;
  txHash: string | null;
  createdAt: string;
};

export type RepaymentHistoryProofPayload = {
  positionId: string;
  repaymentAmount0: string;
  paidLedger0: number;
  dueLedger0: number;
  leafSecret0: string;
  repaymentAmount1: string;
  paidLedger1: number;
  dueLedger1: number;
  leafSecret1: string;
  repaymentAmount2: string;
  paidLedger2: number;
  dueLedger2: number;
  leafSecret2: string;
  proofSecret: string;
  historyRoot: string;
  threshold: number;
  proofNullifier: string;
};

export type RepaymentHistoryProofResult = {
  proofHex: string;
  publicInputsHex: string;
  artifactsDir: string;
};
