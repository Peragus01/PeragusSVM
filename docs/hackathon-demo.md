# Peragus hackathon demo evidence

This document records the successful Peragus roundtrip executed on October 10,
2026. It is a reproducible technical proof, not evidence of a production-money
transfer. OZAV ran in its test environment and every Solana transaction ran on
Devnet.

## Outcome

```text
Pix -> OZAV on-ramp -> contingency resolution -> atomic Solana settlement
    -> OZAV off-ramp -> paid_out
```

| Field | Value |
| --- | --- |
| Settlement ID | `5def0afd-621c-4d79-88a8-8bead9088e6a` |
| Final internal status | `paid_out` |
| On-ramp transfer | `ozav_tr_01M4KNNHFJAZ9NRATSQ5C1XHZH` |
| On-ramp status | `completed` |
| Off-ramp transfer | `ozav_tr_01M4KNPGJ50T6V0ESZKWCNA6K1` |
| Off-ramp status | `completed` |
| Contingency reserve | `refunded` |
| Solana evidence | `verified` |
| Audit warnings | none |

## Amounts and Token-2022 balance proof

OZAV's on-ramp quote converted 500 BRL to 89.55 USDT. The atomic Solana
transaction then produced these exact base-unit deltas:

| Token account | Before | After | Delta |
| --- | ---: | ---: | ---: |
| Payer demo mBRL | 500,000,000 | 0 | -500,000,000 |
| Liquidity demo mBRL | 0 | 500,000,000 | +500,000,000 |
| Liquidity USDT | 10,000,000,000 | 9,910,450,000 | -89,550,000 |
| Recipient USDT | 0 | 89,550,000 | +89,550,000 |

Both demo mBRL and USDT use six decimal places in this run. The OZAV sandbox
off-ramp quote returned 494.52 BRL for 89.55 USDT.

## Solana identities

| Item | Address |
| --- | --- |
| Program | `6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w` |
| Source mint | `9dVXBAfSuBSndr1XboMiAscQh9Yn9fRhALptuoXBgkmK` |
| Destination mint | `5DRGFtNPuNVH2s5B57m9uMPKsWtmM9S4cf3EuPge1WHQ` |
| Settlement PDA | `AkG3ecJLcWjrc4sg5CBWev3yNaU7Tf9eEnnb7oFEBVZK` |
| Reserve PDA | `HvEiHHhBDARLA7PvLd1w5foMPBmhS2iVNry913oGkiHc` |
| Reserve vault PDA | `FcJD6mXNdzkD331Z3uPdoEHwVjW6yLZdziAcKM6ojXqi` |

## Finalized Devnet transactions

| Action | Transaction |
| --- | --- |
| Fund contingency reserve | [3dJ1...BcRd](https://explorer.solana.com/tx/3dJ1dg2DR3962HWEEyTGAdAeHQdJuqvYxmR7EnFLip9Tzny1M2npAS4V4zMd5qZqhDcUYyMuo8mHwfZwd9kaBcRd?cluster=devnet) |
| Refund contingency reserve | [LymS...oheW](https://explorer.solana.com/tx/LymSQRRBgn8uXNmWaYxzksCz6iVjs3oh7M95yun1iXAX7sox4aYrCPgaeaeyFM2AjsQgheEp2aMn48Lw2cjoheW?cluster=devnet) |
| Atomic Token-2022 settlement | [3pKH...ED6V](https://explorer.solana.com/tx/3pKHhBN9NgnNPuAEksc2LjV3jdacRteEK15UsReBJsxM88V3mnyjQxmvaySLhKqG4y7AYXSXjpCQHPuFgcwJED6V?cluster=devnet) |

Each signature returned `Finalized` from `solana confirm --url devnet`.

The settlement repository records the same signature as both the create and
execute signature because the program creates and executes the settlement
atomically in one transaction.

## Persisted OZAV event evidence

Only normalized financial facts are stored. SHA-256 content hashes make a
replayed event distinguishable from changed content under the same event ID.

| Stage | Event | Provider state | Content hash |
| --- | --- | --- | --- |
| On-ramp | `ozav_evt_01M4KNNJJMGCXZGR4PQ37X6YQ2` | `awaiting_payment` | `e52eedaf30d83630f315f09dcc55c244a6272d0c22685c4c2b0cc7b8688ae3ad` |
| On-ramp | `ozav_evt_01M4KNNTXEMDR9VF5YBQKSZRTH` | `payment_confirmed` | `9807e6aadf85a78d96707462e0b70f2355868bef1465889d7774d6a3f89b4b33` |
| On-ramp | `ozav_evt_01M4KNNVMR32DY83Q8CXBP8QEW` | `completed` | `f1c1685bb69733dbb8b835b29ad4730a5b4935945ed6b52a33478f711cd3e272` |
| Off-ramp | `ozav_evt_01M4KNPJ84BWWSA4PP40TFTJNC` | `completed` | `38bffe138bd37d3167bf88203f333a7e91ba9166f77e09d97801a8c60ad8da38` |

The importer validates that each transfer belongs to the persisted customer,
quote, wallet, rail, currencies, amounts, and payout destination before an
event can be recorded.

## Audit checks

The read-only endpoint
`GET /v1/settlements/5def0afd-621c-4d79-88a8-8bead9088e6a/audit`
returned HTTP 200 with:

```json
{
  "onramp_completed": true,
  "reserve_resolved": true,
  "solana_transaction_recorded": true,
  "offramp_completed": true,
  "settlement_paid_out": true,
  "evidence_complete": true
}
```

The response also reported `identity_consistent: true` for both provider legs
and an empty `warnings` array. Its output excludes QR bodies, Pix codes,
credentials, customer IDs, wallet IDs, and idempotency keys.

## Reproduce the audit

After configuring `.env`, applying migrations, and building the backend:

```bash
cd app/backend

npm run demo:audit -- \
  5def0afd-621c-4d79-88a8-8bead9088e6a
```

To query the HTTP representation while the API is running:

```bash
curl -fsS \
  http://127.0.0.1:3000/v1/settlements/5def0afd-621c-4d79-88a8-8bead9088e6a/audit
```

## Failure-path evidence

The separate Pix-expiry scenario demonstrated that a provider transfer can
expire before payment while the Solana reserve is still refunded:

| Field | Value |
| --- | --- |
| Settlement | `a9616fbb-6117-4fe9-a122-95247b232b88` |
| OZAV status | `expired` |
| Internal status | `failed` |
| Reserve status | `refunded` |
| Resolution reason | `provider_failed_before_payment` |
| Duplicate payment | blocked |

Its reserve refund also reached `Finalized` on Devnet:
[2zjJ...bX](https://explorer.solana.com/tx/2zjJGBp9wGMYpe2bt2mVLByZeYJD9keResWSeKaZbST6pweFgzBkPKGPgD9SZ6qpzFmRibiDGKtDuRp4DYJvbmbX?cluster=devnet).

## Scope and safety boundary

- OZAV activity in this record is sandbox activity; no real Pix payment was
  sent.
- Solana activity uses Devnet and demo Token-2022 mints; the balances have no
  monetary value.
- Atomicity applies to the two on-chain token legs. Provider and fiat legs are
  made recoverable through reservation, reconciliation, idempotency, and
  terminal state checks rather than being part of the Solana transaction.
- The current API must remain private until authentication, authorization,
  rate limits, and production signer custody are added.
