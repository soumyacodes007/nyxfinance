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
  signerSecretKey?: string;
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
  // K3: required -- `open_credit` needs the anchor's own `require_auth()`
  // alongside the operator's manager-role auth in the same call.
  anchorSecretKey: string;
  collateralToken?: string;
  lockKey: string;
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
  // K2: must equal the position's proven `credit_commitment_x/y` exactly, or
  // `execute_draw` rejects it (DrawCommitmentMismatch). The contract takes
  // the two coordinates separately, not a single combined value.
  transferCommitmentX: string;
  transferCommitmentY: string;
  // Was previously a gap (see audit-findings.md): execute_draw only checked
  // the commitment matched, but the real confidential_transfer_from was a
  // separate, non-atomic transaction the backend submitted independently, so
  // nothing on-chain enforced that a real transfer happened. execute_draw now
  // performs the transfer itself as a nested cross-contract call, atomically
  // with marking the position drawn. The facility's confidential-token
  // delegation targets a real registered account (a contract can't hold the
  // ECDH key material `set_spender` escrows), so the real credit-executor
  // account must co-sign this call -- same multi-party pattern K3 uses for
  // the anchor in `open_credit`.
  creditExecutorSecretKey: string;
  confidentialTransfer: ConfidentialTransferRequest;
};

export type RepayCreditInput = {
  anchorTransactionId?: string;
  positionId: string;
  facility: string;
  // Repayment debits the anchor's own confidential balance, so the anchor
  // must co-sign `repay` now too (same reasoning as K3, and as
  // creditExecutorSecretKey above for the draw side).
  anchorSecretKey: string;
  repaymentCommitment: string;
  confidentialTransfer: ConfidentialTransferRequest;
};
