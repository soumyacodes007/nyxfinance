import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import type { AppConfig } from "../lib/env.js";

const configured = (value: string | null | undefined): value is string =>
  Boolean(value && value !== "REPLACE_ME" && !value.startsWith("TODO_"));

const commandEnv = (config: AppConfig): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: [
    resolve(config.ozConfidentialRoot, "scripts/bin"),
    process.env.HOME ? resolve(process.env.HOME, ".nargo/bin") : null,
    process.env.HOME ? resolve(process.env.HOME, ".bb") : null,
    process.env.PATH ?? ""
  ]
    .filter((value): value is string => Boolean(value))
    .join(":")
});

export type AuditorDecryptInput = {
  rE: string;
  vAudR: string;
  sigma: string;
  secret?: string;
  rAudR?: string;
  vAudS?: string;
  bAudS?: string;
};

export type TransferXdrInspection = {
  kind: "confidential_transfer" | "confidential_transfer_from";
  r_e: string;
  sigma?: string;
  sigma_a_new?: string;
  v_aud_r: string;
  r_aud_r: string;
  v_aud_s: string;
  b_aud_s?: string;
  a_aud_s?: string;
  requires_emitted_sigma_a?: boolean;
};

const runRunnerJson = (
  config: AppConfig,
  args: string[],
  errorPrefix: string
): Record<string, unknown> => {
  const result = spawnSync("cargo", args, {
    cwd: resolve(config.ozConfidentialRoot),
    env: commandEnv(config),
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(`${errorPrefix}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
};

export const inspectTransferDataXdr = (
  config: AppConfig,
  dataXdrBase64: string
): TransferXdrInspection => {
  if (!configured(config.ozConfidentialRoot)) {
    throw new Error("OZ_CONFIDENTIAL_ROOT is not configured");
  }
  return runRunnerJson(
    config,
    [
      "run",
      "-q",
      "-p",
      "oz-confidential-runner",
      "--",
      "inspect-transfer-xdr",
      dataXdrBase64
    ],
    "transfer XDR inspection failed"
  ) as TransferXdrInspection;
};

export const decryptAuditorPayload = (
  config: AppConfig,
  input: AuditorDecryptInput
): Record<string, unknown> => {
  if (!configured(config.ozConfidentialRoot)) {
    throw new Error("OZ_CONFIDENTIAL_ROOT is not configured");
  }
  if ((input.vAudS || input.bAudS) && !input.rAudR) {
    throw new Error("r_aud_r is required when decrypting sender-channel fields");
  }
  if (input.bAudS && !input.vAudS) {
    throw new Error("v_aud_s is required when decrypting b_aud_s");
  }

  const args = ["run", "-q", "-p", "oz-confidential-runner", "--", "decrypt-auditor", input.rE, input.vAudR, input.sigma, input.secret ?? "55"];
  if (input.rAudR) args.push(input.rAudR);
  if (input.vAudS) args.push(input.vAudS);
  if (input.bAudS) args.push(input.bAudS);

  return {
    ...runRunnerJson(config, args, "auditor decrypt failed"),
    plaintextAmountsIncluded: true,
    caveat:
      "Demo backend is running auditor tooling. Production should run this decryptor on the auditor-controlled machine or in browser WASM."
  } as Record<string, unknown>;
};
