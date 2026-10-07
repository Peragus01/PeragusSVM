import { readFileSync } from "node:fs";
import path from "node:path";

import { Keypair } from "@solana/web3.js";

import { LocalKeypairAuthoritySigner } from "./peragus-solana-transaction.js";

export function parseSolanaKeypair(
  content: string,
  label: string,
): Keypair {
  let parsed: unknown;

  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }

  if (
    !Array.isArray(parsed)
    || parsed.length !== 64
    || parsed.some((value) =>
      !Number.isInteger(value)
      || value < 0
      || value > 255
    )
  ) {
    throw new Error(
      `${label} must contain a 64-byte Solana keypair array`,
    );
  }

  try {
    return Keypair.fromSecretKey(
      Uint8Array.from(parsed as number[]),
    );
  } catch {
    throw new Error(`${label} contains an invalid Solana keypair`);
  }
}

export function loadLocalSolanaAuthority(
  filePath: string,
  label: string,
): LocalKeypairAuthoritySigner {
  if (!path.isAbsolute(filePath)) {
    throw new Error(`${label} path must be absolute`);
  }

  const keypair = parseSolanaKeypair(
    readFileSync(filePath, "utf8"),
    label,
  );

  return new LocalKeypairAuthoritySigner(keypair);
}
