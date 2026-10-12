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

type SolanaAuthorityConfiguration = {
  filePath?: string | undefined;
  keypairBase64?: string | undefined;
  label: string;
};

/**
 * Loads a signer from a local file during development or from a sealed,
 * base64-encoded environment variable on a cloud runtime. The key material is
 * never included in error messages.
 */
export function loadConfiguredSolanaAuthority({
  filePath,
  keypairBase64,
  label,
}: SolanaAuthorityConfiguration): LocalKeypairAuthoritySigner {
  const configuredPath = filePath?.trim();
  const encoded = keypairBase64?.replace(/\s+/g, "");

  if (configuredPath && encoded) {
    throw new Error(
      `${label} must use either KEYPAIR_PATH or KEYPAIR_BASE64, not both`,
    );
  }

  if (encoded) {
    if (
      encoded.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    ) {
      throw new Error(`${label}_BASE64 must contain valid base64`);
    }

    const keypair = parseSolanaKeypair(
      Buffer.from(encoded, "base64").toString("utf8"),
      `${label}_BASE64`,
    );

    return new LocalKeypairAuthoritySigner(keypair);
  }

  if (configuredPath) {
    return loadLocalSolanaAuthority(
      configuredPath,
      `${label}_PATH`,
    );
  }

  throw new Error(
    `${label} requires KEYPAIR_PATH or KEYPAIR_BASE64`,
  );
}
