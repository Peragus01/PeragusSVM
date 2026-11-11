import type { MoneyEnvironment } from "./money-environment.js";

export interface MoneyEnvironmentProbes {
  ozavEnvironment(): Promise<string>;
  solanaGenesisHash(): Promise<string>;
}

type MismatchField = "ozav" | "solana_rpc";

const mismatch = (field: MismatchField): Error =>
  Object.assign(new Error("MONEY_ENVIRONMENT_MISMATCH"), {
    code: "MONEY_ENVIRONMENT_MISMATCH",
    field,
  });

async function probe(
  field: MismatchField,
  run: () => Promise<string>,
  expected: string,
): Promise<void> {
  let actual: string;
  try {
    actual = await run();
  } catch {
    // Fail closed: an unverifiable environment is treated as a mismatch.
    throw mismatch(field);
  }
  if (actual !== expected) throw mismatch(field);
}

/**
 * Refuses to start when the OZAV environment or Solana cluster reachable from
 * this process does not match the money environment derived from the deployment.
 * Never includes keys, URLs or probe values in the error.
 */
export async function assertMoneyEnvironmentAtBoot(
  money: MoneyEnvironment,
  probes: MoneyEnvironmentProbes,
): Promise<void> {
  await probe("ozav", probes.ozavEnvironment, money.mode);
  await probe("solana_rpc", probes.solanaGenesisHash, money.genesisHash);
}

export interface MoneyEnvironmentBootDeps {
  ozavClient: { getCapabilities(): Promise<{ environment: string }> };
  solanaConnection: { getGenesisHash(): Promise<string> };
}

/** Wires the real OZAV and Solana RPC probes into the boot assertion. */
export const assertMoneyEnvironmentAtBootWith = (
  money: MoneyEnvironment,
  deps: MoneyEnvironmentBootDeps,
): Promise<void> =>
  assertMoneyEnvironmentAtBoot(money, {
    ozavEnvironment: async () => (await deps.ozavClient.getCapabilities()).environment,
    solanaGenesisHash: () => deps.solanaConnection.getGenesisHash(),
  });
