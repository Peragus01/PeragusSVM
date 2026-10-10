# Peragus

Peragus is a B2B cross-border settlement orchestrator for Latin America. It
coordinates regulated fiat rails with stablecoin liquidity and uses Solana as
the atomic settlement layer between an acquirer and a liquidity provider.

This repository contains the Solana program and the TypeScript orchestration
backend used for the hackathon demo. The verified demo runs against **OZAV's
test environment**, **Solana Devnet**, and PostgreSQL.

## What the code implements

This is a complete settlement orchestration flow rather than an isolated token
transfer:

1. Create an idempotent B2B settlement and obtain an OZAV sandbox Pix on-ramp
   quote from BRL to USDT.
2. Fund a USDT contingency escrow on Solana before releasing the Pix payment
   instructions.
3. Import, validate, hash, deduplicate, and reconcile OZAV transfer events.
4. Build a partially signed Solana transaction that binds the settlement ID,
   corridor, mints, token accounts, exact amounts, authorities, and expiry.
5. Require the external payer/acquirer signature and execute both Token-2022
   legs in the same transaction: payer to liquidity provider and liquidity
   provider to recipient.
6. Initiate and reconcile the OZAV sandbox USDT-to-BRL Pix off-ramp.
7. Expose a sanitized audit record joining provider events, escrow resolution,
   on-chain signatures, balance evidence, and the final settlement state.

## Failure and recovery model

Atomicity applies to the two token transfers inside one Solana transaction.
Failures outside that boundary are handled by the contingency escrow, durable
state transitions, idempotency, reconciliation, retries, and explicit manual
attention states.

| Scenario | Enforced behavior |
| --- | --- |
| External payer signature is missing | The prepared transaction remains incomplete and cannot execute; no token balance changes occur. |
| Signer, instruction data, PDA, account, mint, amount, or expiry is invalid | The program or confirmation verifier rejects the transaction, and the backend does not persist it as settled. |
| Either Token-2022 transfer fails | Solana rolls back the complete transaction, so neither token leg remains applied. |
| Contingency escrow cannot be funded | The OZAV transfer and Pix payment instructions are not created. |
| Pix expires or the provider fails before source payment | The escrow is refunded to the liquidity authority and the settlement moves to a terminal failure state. |
| Provider fails after source payment but before destination delivery | The worker waits for the fallback SLA and then releases the escrowed USDT to the recipient, provided the reserve is still valid. |
| A paid reserve expires before fallback resolution | Funds are not moved automatically; the case becomes `attention_required`. |
| OZAV completes both on-ramp legs | The contingency escrow is refunded, duplicate events remain idempotent, and the settlement can proceed on-chain. |
| Off-ramp request or polling is interrupted | Persisted quote and transfer state allow retryable workers to resume without creating a duplicate payout. |

## Verified end-to-end result

On October 10, 2026, one complete roundtrip was executed and independently
queried through the audit API:

| Check | Result |
| --- | --- |
| OZAV Pix on-ramp | `completed` |
| Solana contingency reserve | `refunded` |
| Atomic Token-2022 settlement | `verified` |
| OZAV Pix off-ramp | `completed` |
| Internal settlement | `paid_out` |
| Audit warnings | none |

The run moved 500 demo mBRL into liquidity and 89.55 USDT to the recipient in
one Solana transaction. The OZAV sandbox then completed an off-ramp quote of
494.52 BRL. Every Solana signature reached `Finalized` on Devnet.

See [the full evidence record](docs/hackathon-demo.md) for transaction links,
provider event hashes, balance deltas, and reproduction commands.

## Architecture

```mermaid
sequenceDiagram
    participant A as Acquirer
    participant P as Peragus
    participant O as OZAV sandbox
    participant S as Solana Devnet
    participant D as PostgreSQL

    A->>P: Create settlement
    P->>D: Persist and enqueue
    P->>O: Request on-ramp quote
    P->>S: Fund USDT contingency reserve
    P->>O: Create Pix transfer
    P->>O: Poll transfer and events
    P->>D: Deduplicate and reconcile
    P->>S: Resolve contingency reserve
    A->>P: Submit signed settlement
    P->>S: Execute both Token-2022 legs atomically
    P->>O: Create off-ramp transfer
    P->>O: Poll payout and events
    P->>D: Mark settlement paid_out
```

### Atomicity boundary

The two Token-2022 legs execute inside one Solana transaction: either the
source token reaches the liquidity provider and USDT reaches the recipient, or
both transfers revert. Fiat and provider operations cannot share that same
transaction boundary, so Peragus coordinates them with a contingency reserve,
a durable state machine, idempotent event ingestion, and retryable workers.

## Core guarantees

| Area | Implementation |
| --- | --- |
| On-chain settlement | PDA-bound amounts, mints, token accounts, authorities, expiry, and replay protection |
| Contingency liquidity | USDT is reserved before Pix instructions are released and later settled or refunded |
| Provider reconciliation | OZAV transfer snapshots are validated, normalized, hashed, deduplicated, and reconciled |
| Durable orchestration | PostgreSQL plus `pg-boss` retries, exponential backoff, and dead-letter queues |
| State safety | Explicit transitions from `created` through `paid_out`, `failed`, or `revoked` |
| Auditability | One sanitized endpoint joins settlement, on-ramp, reserve, Solana, off-ramp, and event evidence |

## Technology

- Solana program with Anchor and Token-2022
- TypeScript, Node.js 22+, Fastify, and Zod
- PostgreSQL and `pg-boss`
- OZAV test API for Pix on-ramp and off-ramp
- Vitest: 221 tests across 33 test files

The Devnet program ID is:

```text
6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w
```

## Backend setup

Create a local environment file and fill in only test or Devnet values. Never
commit `.env` or local keypairs.

```bash
cd app/backend
cp .env.example .env
npm ci
npm run db:migrate
npm run typecheck
npm test
npm run build
```

Run the API and worker in separate terminals:

```bash
cd app/backend
npm start
```

```bash
cd app/backend
npm run start:worker
```

## Demo commands

```bash
# Prepare a Pix-expiry scenario, then watch the returned settlement ID.
npm run demo:pix-expiry:prepare
npm run demo:pix-expiry:watch -- <settlement_id>

# Simulate Pix payment only in the OZAV test environment.
npm run demo:pix-success

# Execute Pix -> Solana -> Pix.
npm run demo:offramp -- <ozav_payout_destination_id>

# Print the sanitized evidence bundle for any persisted settlement.
npm run demo:audit -- <settlement_id>
```

The roundtrip demo never prints a Pix key, QR payload, API credential, or
idempotency key.

## HTTP surface

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Process health |
| `POST` | `/v1/settlements` | Create an idempotent settlement |
| `GET` | `/v1/settlements/:id` | Read settlement state |
| `GET` | `/v1/settlements/:id/onramp` | Read the persisted Pix on-ramp instructions |
| `POST` | `/v1/settlements/:id/solana/prepare` | Build the partially signed Solana transaction |
| `POST` | `/v1/settlements/:id/solana/confirm` | Verify and persist the confirmed transaction |
| `POST` | `/v1/settlements/:id/offramp` | Initiate the OZAV off-ramp |
| `GET` | `/v1/settlements/:id/audit` | Read sanitized, consolidated evidence |

## Security and deployment status

This is a hackathon-grade integration, not a production deployment:

- OZAV writes are restricted to test credentials and are rejected in
  production mode.
- Local Solana keypair co-signers are rejected in production mode; production
  requires an HSM/KMS signer adapter.
- The API currently has no application-layer authentication. Keep it bound to
  localhost or a private network until authentication and authorization are
  added.
- The on-ramp read route contains Pix payment instructions and must not be
  exposed publicly without access control. The audit route deliberately omits
  QR bodies, Pix codes, provider credentials, customer IDs, wallet IDs, and
  idempotency keys.
- Devnet tokens, sandbox balances, and simulated Pix payments have no monetary
  value.
