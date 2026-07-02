import * as StellarSdk from "@stellar/stellar-sdk";
import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import { getWatcherCursor, insertContractEvent, upsertWatcherCursor } from "../db/sqlite.js";
import { newId } from "../lib/ids.js";
import { fetchLatestLedger, rpcRequest } from "./stellar-rpc.js";

const WATCHER_NAME = "prefunding-contract-events";
const LEDGER_SAFETY_LAG = 5;
const EVENT_NAMES = new Set([
  "CreditOpened",
  "DrawExecuted",
  "Repaid",
  "RepaymentLeafSeeded",
  "RepaymentHistoryRootSet",
  "RepaymentHistoryVerified",
  "DisclosureGrantCreated",
  "DisclosureGrantRevoked",
  "transfer",
  "spender_transfer"
]);

type RpcEvent = {
  contractId?: string;
  contract_id?: string;
  ledger?: number;
  ledgerClosedAt?: string;
  topic?: string[];
  topics?: string[];
  value?: string;
  pagingToken?: string;
  paging_token?: string;
  txHash?: string;
  tx_hash?: string;
};

const trackedContracts = (config: AppConfig): string[] =>
  [
    config.contracts.prefundingCreditLine,
    config.contracts.confidentialCusdc,
    config.contracts.collateralLock,
    config.contracts.repaymentHistory,
    config.contracts.disclosureGrantRegistry
  ].filter((value): value is string => Boolean(value));

const decodeTopic = (topic: string): string | null => {
  try {
    const scVal = StellarSdk.xdr.ScVal.fromXDR(topic, "base64");
    const native = StellarSdk.scValToNative(scVal);
    return typeof native === "string" ? native : null;
  } catch {
    return null;
  }
};

const eventName = (event: RpcEvent): string | null => {
  const topics = event.topics ?? event.topic ?? [];
  for (const topic of topics) {
    const decoded = decodeTopic(topic);
    if (decoded && EVENT_NAMES.has(decoded)) return decoded;
  }
  return null;
};

export const getTrackedContractIds = trackedContracts;

export const syncWatcherOnce = async (config: AppConfig, db: AppDatabase) => {
  const contractIds = trackedContracts(config);
  if (contractIds.length === 0) {
    throw new Error("No watcher contract IDs are configured");
  }

  const latest = await fetchLatestLedger(config.stellarRpcUrl);
  const latestSequence = Number(latest.sequence ?? 0);
  const safeLatestSequence = Math.max(1, latestSequence - LEDGER_SAFETY_LAG);
  const cursor = getWatcherCursor(db, WATCHER_NAME);
  const startLedger = cursor
    ? Math.max(1, Math.min(Number(cursor.cursor) + 1, safeLatestSequence))
    : Math.max(1, latestSequence - 100);
  const result = await rpcRequest<{ events?: RpcEvent[] }>(config.stellarRpcUrl, "getEvents", {
    startLedger,
    filters: [{ type: "contract", contractIds }],
    limit: 100
  });

  let stored = 0;
  for (const event of result.events ?? []) {
    const name = eventName(event);
    if (!name) continue;
    const inserted = insertContractEvent(db, {
      id: newId("evt"),
      contractId: event.contractId ?? event.contract_id ?? "unknown",
      eventName: name,
      ledger: event.ledger ?? null,
      pagingToken: event.pagingToken ?? event.paging_token ?? null,
      txHash: event.txHash ?? event.tx_hash ?? null,
      payload: event
    });
    if (inserted) stored += 1;
  }

  const nextCursor = String(safeLatestSequence);
  upsertWatcherCursor(db, WATCHER_NAME, nextCursor);
  return {
    watcher: WATCHER_NAME,
    startLedger,
    latestLedger: latestSequence,
    nextCursor,
    trackedContracts: contractIds,
    storedEvents: stored
  };
};

export const getWatcherState = (db: AppDatabase) => getWatcherCursor(db, WATCHER_NAME);
