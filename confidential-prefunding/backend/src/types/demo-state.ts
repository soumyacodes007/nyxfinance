import type { ProductStatus, SepStatus } from "./status.js";

export type DemoState = {
  generatedAt: string;
  network: {
    rpcUrl: string;
    horizonUrl: string;
    networkPassphrase: string;
  };
  contracts: Record<string, string>;
  accounts: {
    alpha: string | null;
    facility: string | null;
    auditor: string | null;
    missing: string[];
  };
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
    latestSep31Transaction: {
      id: string;
      status: SepStatus;
      productStatus: ProductStatus;
      amountIn: string | null;
      amountOut: string | null;
      assetCode: string | null;
      senderId: string;
      account: string;
      stellarTransactionId: string | null;
      startedAt: string;
      updatedAt: string;
    } | null;
    latestQuoteId: string | null;
    latestProofJobId: string | null;
    latestDisclosureGrantId: string | null;
    latestConfidentialTransferTxHash: string | null;
  };
  dataSources: {
    quote: {
      oracleMode: string;
      oracleSource: string;
      reflectorPulseContractId: string | null;
      participantPolicy: "chain" | "missing_config";
      collateralPolicyRegistry: "chain" | "missing_config";
      oracleAdapter: "chain" | "missing_config";
      fallbackOrStaticValues: string[];
    };
    privacy: {
      proverMode: string;
      privateWitnessBoundary: string;
      backendStoresPlaintextAmounts: false;
      liveAuditorCiphertextRefs: "present" | "missing";
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
