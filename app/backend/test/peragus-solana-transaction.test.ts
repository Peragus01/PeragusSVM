import { createHash } from "node:crypto";

import {
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  describe,
  expect,
  it,
} from "vitest";

import {
  buildPeragusAtomicSettlementTransaction,
  decodeCorridorId,
  deriveAssociatedTokenAddress,
  derivePeragusAddresses,
  derivePeragusSettlementId,
  LocalKeypairAuthoritySigner,
  partiallySignPeragusTransaction,
  TOKEN_2022_PROGRAM_ID,
  type BuildPeragusAtomicSettlementInput,
} from "../src/providers/peragus-solana-transaction.js";

const PROGRAM_ID = new PublicKey(
  "6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w",
);

const BACKEND_SETTLEMENT_ID =
  "b2a3b4fc-7a59-41ec-9ef6-b9b39b1400a1";
const CORRIDOR_ID = "ab".repeat(32);
const NOW = new Date("2026-10-07T12:00:00.000Z");
const EXPIRES_AT = new Date("2026-10-07T13:00:00.000Z");

interface Fixture {
  payer: Keypair;
  recipient: Keypair;
  attestation: Keypair;
  liquidity: Keypair;
  sourceMint: Keypair;
  destinationMint: Keypair;
  input: BuildPeragusAtomicSettlementInput;
}

function createFixture(): Fixture {
  const payer = Keypair.generate();
  const recipient = Keypair.generate();
  const attestation = Keypair.generate();
  const liquidity = Keypair.generate();
  const sourceMint = Keypair.generate();
  const destinationMint = Keypair.generate();

  return {
    payer,
    recipient,
    attestation,
    liquidity,
    sourceMint,
    destinationMint,
    input: {
      backendSettlementId: BACKEND_SETTLEMENT_ID,
      corridorId: CORRIDOR_ID,
      payerWallet: payer.publicKey,
      recipientWallet: recipient.publicKey,
      sourceAmount: "25000000",
      destinationAmount: "37500",
      expiresAt: EXPIRES_AT,
      sourceMint: sourceMint.publicKey,
      destinationMint: destinationMint.publicKey,
      attestationAuthority: attestation.publicKey,
      liquidityAuthority: liquidity.publicKey,
      programId: PROGRAM_ID,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 123_456,
    },
  };
}

describe("Peragus Solana atomic settlement transaction", () => {
  it("derives a deterministic 32-byte on-chain settlement ID", () => {
    const first = derivePeragusSettlementId(
      BACKEND_SETTLEMENT_ID,
    );
    const second = derivePeragusSettlementId(
      BACKEND_SETTLEMENT_ID.toUpperCase(),
    );

    expect(first).toHaveLength(32);
    expect(first.equals(second)).toBe(true);
    expect(first.toString("hex")).toBe(
      createHash("sha256")
        .update("peragus:settlement:v1\0")
        .update(BACKEND_SETTLEMENT_ID)
        .digest("hex"),
    );
  });

  it("derives deterministic PDAs and Token-2022 associated accounts", () => {
    const fixture = createFixture();
    const first = derivePeragusAddresses(fixture.input);
    const second = derivePeragusAddresses(fixture.input);

    expect(first.settlementId.equals(second.settlementId)).toBe(
      true,
    );
    expect(first.addresses.settlement.equals(
      second.addresses.settlement,
    )).toBe(true);
    expect(first.addresses.payerSource.equals(
      deriveAssociatedTokenAddress(
        fixture.payer.publicKey,
        fixture.sourceMint.publicKey,
      ),
    )).toBe(true);
    expect(first.addresses.liquidityDestination.equals(
      deriveAssociatedTokenAddress(
        fixture.liquidity.publicKey,
        fixture.destinationMint.publicKey,
      ),
    )).toBe(true);
  });

  it("honors explicit token-account addresses from an acquirer", () => {
    const fixture = createFixture();
    const tokenAccounts = {
      payerSource: Keypair.generate().publicKey,
      liquiditySource: Keypair.generate().publicKey,
      liquidityDestination: Keypair.generate().publicKey,
      recipientDestination: Keypair.generate().publicKey,
    };

    const derived = derivePeragusAddresses({
      ...fixture.input,
      tokenAccounts,
    });

    expect(derived.addresses.payerSource.equals(
      tokenAccounts.payerSource,
    )).toBe(true);
    expect(derived.addresses.liquiditySource.equals(
      tokenAccounts.liquiditySource,
    )).toBe(true);
    expect(derived.addresses.liquidityDestination.equals(
      tokenAccounts.liquidityDestination,
    )).toBe(true);
    expect(derived.addresses.recipientDestination.equals(
      tokenAccounts.recipientDestination,
    )).toBe(true);
  });

  it("builds create and execute instructions in one atomic transaction", () => {
    const fixture = createFixture();
    const prepared = buildPeragusAtomicSettlementTransaction(
      fixture.input,
      NOW,
    );

    expect(prepared.transaction.instructions).toHaveLength(2);
    expect(prepared.transaction.feePayer?.equals(
      fixture.payer.publicKey,
    )).toBe(true);
    expect(prepared.transaction.recentBlockhash).toBe(
      fixture.input.recentBlockhash,
    );
    expect(prepared.transaction.lastValidBlockHeight).toBe(
      fixture.input.lastValidBlockHeight,
    );

    const [createInstruction, executeInstruction] =
      prepared.transaction.instructions;

    expect(createInstruction).toBeDefined();
    expect(executeInstruction).toBeDefined();
    expect(createInstruction!.programId.equals(PROGRAM_ID)).toBe(
      true,
    );
    expect(executeInstruction!.programId.equals(PROGRAM_ID)).toBe(
      true,
    );
    expect(Array.from(createInstruction!.data.subarray(0, 8))).toEqual(
      [109, 119, 255, 55, 76, 73, 106, 126],
    );
    expect(Array.from(executeInstruction!.data)).toEqual(
      [237, 120, 82, 62, 224, 193, 147, 137],
    );
    expect(createInstruction!.keys).toHaveLength(6);
    expect(executeInstruction!.keys).toHaveLength(12);
  });

  it("encodes the Anchor arguments exactly as the Rust instruction expects", () => {
    const fixture = createFixture();
    const prepared = buildPeragusAtomicSettlementTransaction(
      fixture.input,
      NOW,
    );
    const data = prepared.transaction.instructions[0]!.data;

    expect(data).toHaveLength(192);
    expect(data.subarray(8, 40).equals(
      prepared.settlementId,
    )).toBe(true);
    expect(data.readBigUInt64LE(40)).toBe(25_000_000n);
    expect(data.readBigUInt64LE(48)).toBe(37_500n);
    expect(data.readBigInt64LE(56)).toBe(
      BigInt(Math.floor(EXPIRES_AT.getTime() / 1_000)),
    );
    expect(new PublicKey(data.subarray(64, 96)).equals(
      fixture.sourceMint.publicKey,
    )).toBe(true);
    expect(new PublicKey(data.subarray(96, 128)).equals(
      fixture.destinationMint.publicKey,
    )).toBe(true);
    expect(new PublicKey(data.subarray(128, 160)).equals(
      fixture.recipient.publicKey,
    )).toBe(true);
    expect(new PublicKey(data.subarray(160, 192)).equals(
      fixture.liquidity.publicKey,
    )).toBe(true);
  });

  it("marks only the acquirer, attestor, and liquidity authority as signers", () => {
    const fixture = createFixture();
    const prepared = buildPeragusAtomicSettlementTransaction(
      fixture.input,
      NOW,
    );
    const message = prepared.transaction.compileMessage();
    const signers = message.accountKeys
      .slice(0, message.header.numRequiredSignatures)
      .map((key) => key.toBase58());

    expect(new Set(signers)).toEqual(new Set([
      fixture.payer.publicKey.toBase58(),
      fixture.attestation.publicKey.toBase58(),
      fixture.liquidity.publicKey.toBase58(),
    ]));
  });

  it("partially signs with Peragus and leaves the acquirer signature empty", async () => {
    const fixture = createFixture();
    const prepared = buildPeragusAtomicSettlementTransaction(
      fixture.input,
      NOW,
    );

    const partial = await partiallySignPeragusTransaction(
      prepared,
      {
        payerWallet: fixture.payer.publicKey,
        attestationAuthority:
          new LocalKeypairAuthoritySigner(
            fixture.attestation,
          ),
        liquidityAuthority:
          new LocalKeypairAuthoritySigner(
            fixture.liquidity,
          ),
      },
    );

    const transaction = Transaction.from(
      Buffer.from(partial.transactionBase64, "base64"),
    );
    const payerSignature = transaction.signatures.find(
      ({ publicKey }) =>
        publicKey.equals(fixture.payer.publicKey),
    );

    expect(payerSignature?.signature).toBeNull();
    expect(transaction.verifySignatures(false)).toBe(true);
    expect(transaction.verifySignatures(true)).toBe(false);
    expect(partial.requiredExternalSigner).toBe(
      fixture.payer.publicKey.toBase58(),
    );
    expect(partial.settlementPda).toBe(
      prepared.addresses.settlement.toBase58(),
    );
  });

  it("becomes fully valid after the acquirer signs the same message", async () => {
    const fixture = createFixture();
    const prepared = buildPeragusAtomicSettlementTransaction(
      fixture.input,
      NOW,
    );
    const partial = await partiallySignPeragusTransaction(
      prepared,
      {
        payerWallet: fixture.payer.publicKey,
        attestationAuthority:
          new LocalKeypairAuthoritySigner(
            fixture.attestation,
          ),
        liquidityAuthority:
          new LocalKeypairAuthoritySigner(
            fixture.liquidity,
          ),
      },
    );
    const transaction = Transaction.from(
      Buffer.from(partial.transactionBase64, "base64"),
    );

    transaction.partialSign(fixture.payer);

    expect(transaction.verifySignatures(true)).toBe(true);
    expect(
      createHash("sha256")
        .update(transaction.serializeMessage())
        .digest("hex"),
    ).toBe(partial.messageHash);
  });

  it("rejects a signer that is not the prepared Peragus authority", async () => {
    const fixture = createFixture();
    const prepared = buildPeragusAtomicSettlementTransaction(
      fixture.input,
      NOW,
    );

    await expect(partiallySignPeragusTransaction(
      prepared,
      {
        payerWallet: fixture.payer.publicKey,
        attestationAuthority:
          new LocalKeypairAuthoritySigner(
            Keypair.generate(),
          ),
        liquidityAuthority:
          new LocalKeypairAuthoritySigner(
            fixture.liquidity,
          ),
      },
    )).rejects.toThrow(
      "attestationAuthority does not match",
    );
  });

  it("rejects malformed identifiers, expired attestations, and invalid amounts", () => {
    const fixture = createFixture();

    expect(() => decodeCorridorId("ab")).toThrow(
      "32 hexadecimal bytes",
    );
    expect(() => derivePeragusSettlementId("not-a-uuid")).toThrow(
      "canonical UUID",
    );
    expect(() => buildPeragusAtomicSettlementTransaction(
      {
        ...fixture.input,
        sourceAmount: "0",
      },
      NOW,
    )).toThrow("sourceAmount must be a positive u64");
    expect(() => buildPeragusAtomicSettlementTransaction(
      {
        ...fixture.input,
        expiresAt: NOW,
      },
      NOW,
    )).toThrow("expiresAt must be in the future");
  });

  it("uses the Token-2022 program in every derived associated account", () => {
    const fixture = createFixture();
    const derived = deriveAssociatedTokenAddress(
      fixture.payer.publicKey,
      fixture.sourceMint.publicKey,
    );
    const [expected] = PublicKey.findProgramAddressSync(
      [
        fixture.payer.publicKey.toBuffer(),
        TOKEN_2022_PROGRAM_ID.toBuffer(),
        fixture.sourceMint.publicKey.toBuffer(),
      ],
      new PublicKey(
        "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      ),
    );

    expect(derived.equals(expected)).toBe(true);
  });
});
