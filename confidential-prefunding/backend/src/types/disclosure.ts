export type DisclosureScope = {
  fields: string[];
  label?: string;
};

export type EncryptedDisclosureBundle = {
  ciphertext: string;
  nonce: string;
  authTag: string;
  algorithm: "aes-256-gcm";
};

export type DisclosureBundleRecord = EncryptedDisclosureBundle & {
  id: string;
  grantId: string;
  owner: string;
  viewerHash: string;
  positionId: string;
  eventHash: string;
  scopeHash: string;
  bundleHash: string;
  onChainTxHash: string | null;
  revoked: boolean;
  expiresAtLedger: number;
  createdAt: string;
  updatedAt: string;
};

export type DisclosureBundlePlaintext = {
  positionId: string;
  scope: DisclosureScope;
  scopedData: Record<string, unknown>;
  proof?: {
    type: string;
    publicInputsHex: string;
    proofHex: string;
  };
  auditorCiphertexts?: Record<string, unknown>;
  clientVerification: {
    expectedScopeHash: string;
  };
};
