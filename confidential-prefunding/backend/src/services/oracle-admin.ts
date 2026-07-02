import * as StellarSdk from "@stellar/stellar-sdk";
import type { AppConfig } from "../lib/env.js";
import { fetchLatestLedger } from "./stellar-rpc.js";
import { operatorKeypair, submitOperatorContractCall } from "./operator-tx.js";
import { ContractReader } from "./contract-reader.js";

const addressArg = (address: string): StellarSdk.xdr.ScVal =>
  StellarSdk.Address.fromString(address).toScVal();

const reflectorOtherAssetArg = (symbol: string): StellarSdk.xdr.ScVal =>
  StellarSdk.xdr.ScVal.scvVec([
    StellarSdk.xdr.ScVal.scvSymbol("Other"),
    StellarSdk.xdr.ScVal.scvSymbol(symbol)
  ]);

const asBigInt = (value: unknown, field: string): bigint => {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) return BigInt(value);
  throw new Error(`Reflector ${field} is not numeric`);
};

const getPriceField = (record: unknown, field: "price" | "timestamp"): unknown => {
  if (record instanceof Map) return record.get(field);
  if (record && typeof record === "object" && field in record) {
    return (record as Record<string, unknown>)[field];
  }
  throw new Error(`Reflector lastprice response missing ${field}`);
};

const scaleReflectorPriceToE7 = (price: bigint, decimals: number): bigint => {
  if (price <= 0n) throw new Error("Reflector price is not positive");
  if (decimals === 7) return price;
  if (decimals > 7) return price / 10n ** BigInt(decimals - 7);
  return price * 10n ** BigInt(7 - decimals);
};

const fetchReflectorPriceE7 = async (
  config: AppConfig,
  symbol: string
): Promise<{ priceE7: bigint; timestamp: bigint; decimals: number }> => {
  if (!config.reflectorPulseContractId) {
    throw new Error("REFLECTOR_PULSE_CONTRACT_ID is not configured");
  }
  const reader = new ContractReader(config);
  const [priceRecord, decimalsRaw] = await Promise.all([
    reader.invokeRead(config.reflectorPulseContractId, "lastprice", [reflectorOtherAssetArg(symbol)]),
    reader.invokeRead(config.reflectorPulseContractId, "decimals", [])
  ]);
  if (priceRecord === null || priceRecord === undefined) {
    throw new Error(`Reflector has no lastprice for ${symbol}`);
  }
  const decimals = Number(decimalsRaw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(`Reflector decimals out of range: ${String(decimalsRaw)}`);
  }
  const price = asBigInt(getPriceField(priceRecord, "price"), "price");
  const timestamp = asBigInt(getPriceField(priceRecord, "timestamp"), "timestamp");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now > timestamp && now - timestamp > BigInt(config.reflectorStalenessSeconds)) {
    throw new Error(`Reflector price for ${symbol} is stale`);
  }
  return {
    priceE7: scaleReflectorPriceToE7(price, decimals),
    timestamp,
    decimals
  };
};

export const refreshOracle = async (
  config: AppConfig,
  input: { asset?: string; priceE7?: string; updatedLedger?: number }
) => {
  const contractId = config.contracts.oracleAdapter;
  const asset = input.asset ?? config.contracts.collateralToken;
  if (!contractId) throw new Error("ORACLE_ADAPTER_CONTRACT_ID is not configured");
  if (!asset) throw new Error("COLLATERAL_TOKEN_CONTRACT_ID is not configured");

  const latestLedger = input.updatedLedger ?? Number((await fetchLatestLedger(config.stellarRpcUrl)).sequence ?? 0);
  if (!Number.isFinite(latestLedger) || latestLedger <= 0) {
    throw new Error("latest ledger is unavailable");
  }
  const operator = operatorKeypair(config);
  const reflector =
    config.oracleMode === "reflector" && !input.priceE7
      ? await fetchReflectorPriceE7(config, config.reflectorQuoteAsset)
      : null;
  const priceE7 = reflector?.priceE7 ?? BigInt(input.priceE7 ?? "10000000");
  const tx = await submitOperatorContractCall(config, contractId, "set_price", [
    addressArg(asset),
    StellarSdk.nativeToScVal(priceE7, { type: "i128" }),
    StellarSdk.nativeToScVal(latestLedger, { type: "u32" }),
    addressArg(operator.publicKey())
  ]);
  return {
    oracleMode: config.oracleMode,
    oracleSource: reflector ? "reflector_sep40" : "demo_adapter",
    reflector: reflector
      ? {
          contractId: config.reflectorPulseContractId,
          symbol: config.reflectorQuoteAsset,
          baseAsset: config.reflectorBaseAsset,
          decimals: reflector.decimals,
          timestamp: reflector.timestamp.toString()
        }
      : null,
    oracleAdapter: contractId,
    asset,
    priceE7: priceE7.toString(),
    updatedLedger: latestLedger,
    tx
  };
};

export const refreshMockOracle = refreshOracle;
