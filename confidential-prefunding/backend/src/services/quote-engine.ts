import type { AppConfig } from "../lib/env.js";
import { expiresIn, newId } from "../lib/ids.js";
import type { PrefundingQuote, PrefundingQuoteRequest } from "../types/quote.js";
import type { AppDatabase } from "../db/sqlite.js";
import { insertQuote, updateProductStatus } from "../db/sqlite.js";
import { ContractReader } from "./contract-reader.js";

const calculateFee = (amount: string, feeBps: number): string => {
  const value = BigInt(amount);
  return ((value * BigInt(feeBps)) / 10_000n).toString();
};

export const createQuote = async (
  config: AppConfig,
  db: AppDatabase,
  input: PrefundingQuoteRequest
): Promise<PrefundingQuote> => {
  const collateralPolicy = config.contracts.collateralPolicy;
  const participantPolicy = config.contracts.participantPolicy;
  const collateralToken = input.collateralToken ?? config.contracts.collateralToken;
  if (!collateralPolicy) throw new Error("COLLATERAL_POLICY_CONTRACT_ID is not configured");
  if (!participantPolicy) throw new Error("PARTICIPANT_POLICY_CONTRACT_ID is not configured");
  if (!collateralToken) throw new Error("COLLATERAL_TOKEN_CONTRACT_ID is not configured");

  const reader = new ContractReader(config);
  const tokenArg = reader.addressArg(collateralToken);
  const accountArg = reader.addressArg(input.account);
  const [participantApprovedRaw, eligibleRaw, haircutRaw, maxTenorRaw, oracleRaw] = await Promise.all([
    reader.invokeRead(participantPolicy, "is_approved", [accountArg]),
    reader.invokeRead(collateralPolicy, "is_eligible", [tokenArg]),
    reader.invokeRead(collateralPolicy, "haircut_bps", [tokenArg]),
    reader.invokeRead(collateralPolicy, "max_tenor_days", [tokenArg]),
    reader.invokeRead(collateralPolicy, "oracle", [tokenArg])
  ]);

  if (participantApprovedRaw !== true) {
    throw new Error(`Participant ${input.account} is not approved by ParticipantPolicy`);
  }

  if (eligibleRaw !== true) {
    throw new Error(`Collateral token ${collateralToken} is not eligible`);
  }

  const haircutBps = Number(haircutRaw);
  const maxTenorDays = Number(maxTenorRaw);
  if (input.tenorDays <= 0 || input.tenorDays > 5 || input.tenorDays > maxTenorDays) {
    throw new Error(`Tenor ${input.tenorDays} exceeds max tenor ${Math.min(5, maxTenorDays)}`);
  }

  const oracle = String(oracleRaw);
  const [priceRaw, updatedLedgerRaw] = await Promise.all([
    reader.invokeRead(oracle, "price_e7", [reader.addressArg(collateralToken)]),
    reader.invokeRead(oracle, "updated_ledger", [reader.addressArg(collateralToken)])
  ]);

  const quote: PrefundingQuote = {
    id: newId("quote"),
    account: input.account,
    anchorTransactionId: input.anchorTransactionId ?? null,
    collateralToken,
    requestedCreditAmount: input.requestedCreditAmount,
    tenorDays: input.tenorDays,
    participantApproved: true,
    oraclePriceE7: String(priceRaw),
    oracleUpdatedLedger: Number(updatedLedgerRaw),
    haircutBps,
    maxTenorDays,
    feeBps: config.prefundingFeeBps,
    feeAmount: calculateFee(input.requestedCreditAmount, config.prefundingFeeBps),
    expiresAt: expiresIn(5 * 60 * 1000),
    source: "chain"
  };

  insertQuote(db, quote);
  if (quote.anchorTransactionId) {
    updateProductStatus(db, quote.anchorTransactionId, "credit_quote_ready");
  }
  return quote;
};
