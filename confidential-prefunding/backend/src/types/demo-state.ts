import type { ProductStatus, SepStatus } from "./status.js";

export type DemoState = {
  generatedAt: string;
  network: {
    rpcUrl: string;
    horizonUrl: string;
    networkPassphrase: string;
  };
  contracts: Record<string, string>;
  anchorPlatform: {
    publicUrl: string;
    reachable: boolean;
    stellarTomlPreview: string[];
    error?: string;
  };
  stellar: {
    rpc: {
      status: string;
      latestLedgerSequence: number | null;
    };
    horizon: {
      coreLatestLedger: number | null;
      historyLatestLedger: number | null;
      networkPassphrase: string | null;
    };
  };
  product: {
    latestSepStatus: SepStatus | null;
    latestProductStatus: ProductStatus | null;
    latestQuoteId: string | null;
    latestProofJobId: string | null;
    latestDisclosureGrantId: string | null;
  };
  dataSources: {
    quote: {
      participantPolicy: "chain" | "missing_config";
      collateralPolicyRegistry: "chain" | "missing_config";
      oracleAdapter: "chain" | "missing_config";
      fallbackOrStaticValues: string[];
    };
    phase6: {
      repaymentHistoryRegistry: "chain" | "missing_config";
      repaymentHistoryVerifier: "chain" | "missing_config";
      disclosureGrantRegistry: "chain" | "missing_config";
      fallbackOrStaticValues: string[];
    };
  };
  watcher: {
    cursor: string | null;
    updatedAt: string | null;
    trackedContracts: string[];
  };
};
