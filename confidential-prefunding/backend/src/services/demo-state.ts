import type { AppConfig } from "../lib/env.js";
import type { AppDatabase } from "../db/sqlite.js";
import {
  getLatestAnchorTransaction,
  getLatestDisclosureGrantId,
  getLatestProofJobId,
  getLatestQuoteId
} from "../db/sqlite.js";
import type { DemoState } from "../types/demo-state.js";
import { fetchAnchorToml, fetchHorizonRoot, fetchLatestLedger, fetchRpcHealth } from "./stellar-rpc.js";
import { getTrackedContractIds, getWatcherState } from "./watcher.js";
import { snapshotCache } from "./snapshot-cache.js";

const SNAPSHOT_KEY = "demo_state";
const sourceStatus = (value: string | null): "chain" | "missing_config" =>
  value ? "chain" : "missing_config";
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const buildLiveSnapshot = async (
  config: AppConfig,
  db: AppDatabase
): Promise<DemoState> => {
  const [rpcHealth, latestLedger, horizonRoot, anchorTomlResult] = await Promise.all([
    fetchRpcHealth(config.stellarRpcUrl),
    fetchLatestLedger(config.stellarRpcUrl),
    fetchHorizonRoot(config.stellarHorizonUrl),
    fetchAnchorToml(config.anchorStellarTomlUrl)
      .then((value) => ({ ok: true as const, value }))
      .catch((error) => ({ ok: false as const, error: errorMessage(error) }))
  ]);
  const latestTx = getLatestAnchorTransaction(db);
  const watcher = getWatcherState(db);

  const snapshot: DemoState = {
    generatedAt: new Date().toISOString(),
    network: {
      rpcUrl: config.stellarRpcUrl,
      horizonUrl: config.stellarHorizonUrl,
      networkPassphrase: config.stellarNetworkPassphrase
    },
    contracts: Object.fromEntries(
      Object.entries(config.contracts).filter(([, value]) => Boolean(value))
    ) as Record<string, string>,
    anchorPlatform: {
      publicUrl: config.anchorPlatformPublicUrl,
      stellarTomlPreview: anchorTomlResult.ok ? anchorTomlResult.value.split("\n").slice(0, 6) : [],
      reachable: anchorTomlResult.ok,
      ...(anchorTomlResult.ok ? {} : { error: anchorTomlResult.error })
    },
    stellar: {
      rpc: {
        status: rpcHealth.status ?? "unknown",
        latestLedgerSequence: latestLedger.sequence ?? null
      },
      horizon: {
        coreLatestLedger:
          typeof horizonRoot.core_latest_ledger === "number" ? horizonRoot.core_latest_ledger : null,
        historyLatestLedger:
          typeof horizonRoot.history_latest_ledger === "number" ? horizonRoot.history_latest_ledger : null,
        networkPassphrase:
          typeof horizonRoot.network_passphrase === "string" ? horizonRoot.network_passphrase : null
      }
    },
    product: {
      latestSepStatus: latestTx?.sep_status ?? null,
      latestProductStatus: latestTx?.product_status ?? null,
      latestQuoteId: getLatestQuoteId(db),
      latestProofJobId: getLatestProofJobId(db),
      latestDisclosureGrantId: getLatestDisclosureGrantId(db)
    },
    dataSources: {
      quote: {
        participantPolicy: sourceStatus(config.contracts.participantPolicy),
        collateralPolicyRegistry: sourceStatus(config.contracts.collateralPolicy),
        oracleAdapter: sourceStatus(config.contracts.oracleAdapter),
        fallbackOrStaticValues: [
          !config.contracts.participantPolicy ? "PARTICIPANT_POLICY_CONTRACT_ID missing" : null,
          !config.contracts.collateralPolicy ? "COLLATERAL_POLICY_CONTRACT_ID missing" : null,
          !config.contracts.oracleAdapter ? "ORACLE_ADAPTER_CONTRACT_ID missing" : null
        ].filter((value): value is string => Boolean(value))
      },
      phase6: {
        repaymentHistoryRegistry: sourceStatus(config.contracts.repaymentHistory),
        repaymentHistoryVerifier: sourceStatus(config.contracts.repaymentHistoryVerifier),
        disclosureGrantRegistry: sourceStatus(config.contracts.disclosureGrantRegistry),
        fallbackOrStaticValues: [
          !config.contracts.repaymentHistory ? "REPAYMENT_HISTORY_CONTRACT_ID missing" : null,
          !config.contracts.repaymentHistoryVerifier
            ? "REPAYMENT_HISTORY_VERIFIER_CONTRACT_ID missing"
            : null,
          !config.contracts.disclosureGrantRegistry
            ? "DISCLOSURE_GRANT_REGISTRY_CONTRACT_ID missing"
            : null
        ].filter((value): value is string => Boolean(value))
      }
    },
    watcher: {
      cursor: watcher?.cursor ?? null,
      updatedAt: watcher?.updatedAt ?? null,
      trackedContracts: getTrackedContractIds(config)
    }
  };

  snapshotCache.putLastKnownGood(db, SNAPSHOT_KEY, snapshot, "live");
  return snapshot;
};

export const getDemoState = async (config: AppConfig, db: AppDatabase) => {
  try {
    return {
      source: "live" as const,
      snapshot: await buildLiveSnapshot(config, db)
    };
  } catch (error) {
    const cached = snapshotCache.getLastKnownGood<DemoState>(db, SNAPSHOT_KEY);
    if (!cached) {
      return {
        source: "unavailable" as const,
        error: error instanceof Error ? error.message : String(error),
        snapshot: null
      };
    }
    return {
      source: "cache" as const,
      snapshot: cached.payload,
      cacheMetadata: {
        sourceStatus: cached.sourceStatus,
        sourceTimestamp: cached.sourceTimestamp,
        updatedAt: cached.updatedAt
      },
      error: error instanceof Error ? error.message : String(error)
    };
  }
};
