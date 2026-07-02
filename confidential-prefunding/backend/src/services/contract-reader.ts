import * as StellarSdk from "@stellar/stellar-sdk";
import type { AppConfig } from "../lib/env.js";
import { buildRpcServer, nativeToString } from "./stellar-rpc.js";

export class ContractReader {
  private readonly rpc: StellarSdk.rpc.Server;

  constructor(private readonly config: AppConfig) {
    this.rpc = buildRpcServer(config);
  }

  async invokeRead(contractId: string, method: string, args: StellarSdk.xdr.ScVal[]): Promise<unknown> {
    if (!this.config.demoAnchorAccount || this.config.demoAnchorAccount === "REPLACE_ME") {
      throw new Error("DEMO_ANCHOR_ACCOUNT is required for Soroban read simulation");
    }

    const account = await this.rpc.getAccount(this.config.demoAnchorAccount);
    const contract = new StellarSdk.Contract(contractId);
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: this.config.stellarNetworkPassphrase
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(180)
      .build();

    const simulation = await this.rpc.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationError(simulation)) {
      throw new Error(`Simulation failed for ${contractId}.${method}: ${simulation.error}`);
    }
    if (!StellarSdk.rpc.Api.isSimulationSuccess(simulation) || !simulation.result?.retval) {
      throw new Error(`Simulation returned no value for ${contractId}.${method}`);
    }
    return StellarSdk.scValToNative(simulation.result.retval);
  }

  async invokeString(contractId: string, method: string, args: StellarSdk.xdr.ScVal[]): Promise<string> {
    return nativeToString(await this.invokeRead(contractId, method, args));
  }

  addressArg(address: string): StellarSdk.xdr.ScVal {
    return StellarSdk.Address.fromString(address).toScVal();
  }
}
