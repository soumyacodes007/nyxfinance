import * as StellarSdk from "@stellar/stellar-sdk";
import type { AppConfig } from "../lib/env.js";

export type RpcJsonResult = Record<string, unknown>;

export const rpcRequest = async <T = RpcJsonResult>(
  url: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${method}-${Date.now()}`,
      method,
      params
    })
  });

  if (!response.ok) {
    throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { result?: T; error?: { message?: string } };
  if (payload.error) {
    throw new Error(`RPC ${method} returned ${payload.error.message ?? "unknown error"}`);
  }
  if (payload.result === undefined) {
    throw new Error(`RPC ${method} returned no result`);
  }
  return payload.result;
};

export const fetchRpcHealth = async (rpcUrl: string): Promise<{ status?: string }> =>
  rpcRequest(rpcUrl, "getHealth");

export const fetchLatestLedger = async (
  rpcUrl: string
): Promise<{ sequence?: number; id?: string; protocolVersion?: number }> =>
  rpcRequest(rpcUrl, "getLatestLedger");

export const fetchHorizonRoot = async (horizonUrl: string): Promise<Record<string, unknown>> => {
  const response = await fetch(horizonUrl, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Horizon root failed with HTTP ${response.status}`);
  }
  return (await response.json()) as Record<string, unknown>;
};

export const fetchAnchorToml = async (anchorTomlUrl: string): Promise<string> => {
  const response = await fetch(anchorTomlUrl);
  if (!response.ok) {
    throw new Error(`Anchor TOML failed with HTTP ${response.status}`);
  }
  return response.text();
};

export const buildRpcServer = (config: AppConfig): StellarSdk.rpc.Server =>
  new StellarSdk.rpc.Server(config.stellarRpcUrl, { allowHttp: config.stellarRpcUrl.startsWith("http://") });

export const buildHorizonServer = (config: AppConfig): StellarSdk.Horizon.Server =>
  new StellarSdk.Horizon.Server(config.stellarHorizonUrl, {
    allowHttp: config.stellarHorizonUrl.startsWith("http://")
  });

export const nativeToString = (value: unknown): string => {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
};
