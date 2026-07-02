export type PrefundingQuoteRequest = {
  anchorTransactionId?: string;
  account: string;
  collateralToken?: string;
  requestedCreditAmount: string;
  tenorDays: number;
};

export type PrefundingQuote = {
  id: string;
  account: string;
  anchorTransactionId: string | null;
  collateralToken: string;
  requestedCreditAmount: string;
  tenorDays: number;
  participantApproved: boolean;
  oraclePriceE7: string;
  oracleUpdatedLedger: number | null;
  haircutBps: number;
  maxTenorDays: number;
  feeBps: number;
  feeAmount: string;
  expiresAt: string;
  source: "chain";
};
