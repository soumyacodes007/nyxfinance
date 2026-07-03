export type CreditLineTxResult = {
  hash: string;
  ledger?: number;
  confidentialTransfer?: ConfidentialTransferResult;
  drawRecorded?: {
    hash: string;
    ledger?: number;
  };
  repaymentRecorded?: {
    hash: string;
    ledger?: number;
  };
};

export type ConfidentialTransferMethod = "confidential_transfer" | "confidential_transfer_from";

export type ConfidentialTransferRequest = {
  tokenContractId?: string;
  method?: ConfidentialTransferMethod;
  spender?: string;
  from: string;
  to: string;
  dataXdrBase64: string;
  mergeBeforeTransfer?: boolean;
  auditorPayload?: Record<string, unknown>;
  eventPayload?: Record<string, unknown>;
};

export type ConfidentialTransferResult = {
  tokenContractId: string;
  method: ConfidentialTransferMethod;
  signer: string;
  spender: string | null;
  from: string;
  to: string;
  txHash: string;
  ledger?: number;
  dataXdrSha256: string;
  dataXdrBase64?: string;
  auditorPayloadRef: "live_ciphertext" | "not_provided";
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
  confidentialTransfer: ConfidentialTransferRequest;
};

export type RepayCreditInput = {
  anchorTransactionId?: string;
  positionId: string;
  repaymentCommitment: string;
  confidentialTransfer?: ConfidentialTransferRequest;
};
