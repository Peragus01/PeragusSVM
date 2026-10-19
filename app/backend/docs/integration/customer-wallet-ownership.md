# Customer Solana wallet ownership (sandbox only)

## Scope

This proves control of a Solana signing key for an already authenticated PF account.
Supabase email/password remains the login. This is a versioned application linking
message, **not** a SIWS login endpoint, a transaction, a financial authorization, a
KYC approval, wallet funding or proof of the user's legal identity. There are no
RPC, provider, USDT, custody, account-opening or payment calls.

`CUSTOMER_WALLET_LINKING_ENABLED` defaults to false, only on the API. The executable
server requires pinned staging database/Auth and keeps the existing financial/demo
flags off. No new secret/key/dependency is introduced. Only devnet/test evidence
is supported; a live network proof requires a separately designed rollout.

## HTTP contract

All routes require the confirmed Supabase access token, an unsuspended own PF
profile and the feature flag. Reject unknown query selectors and extra JSON body
fields. Responses have Cache-Control:no-store. Requests are capped at 4 KiB with
private JSON parsing; malformed JSON is not echoed. No bodies, wallet addresses,
nonces or signatures are logged by these handlers.

| Route | Body | Response |
| --- | --- | --- |
| GET `/v1/me/wallet` | none | Own linked public wallet metadata, or data:null |
| POST `/v1/me/wallet/challenge` | `{wallet_address: <canonical base58 address>}` | 201 with challenge_id, exact message, expires_at, domain, URI and test network |
| POST `/v1/me/wallet/confirm` | `{challenge_id: <UUID>, signature_base64: <canonical 64-byte signature>}` | 200 with own wallet_address, verified_at, proof_type, network, environment and operations_enabled:false |

Only canonical on-curve Solana Ed25519 public keys are accepted. Zero/system or
program-derived addresses are not a signing wallet. Frontend connection alone is
not proof. The server generates a random 32-byte nonce, random UUID, issue time and
five-minute expiry. Domain and URI are fixed to the staging API; they never come
from Host, Origin, forwarded headers or client input. The message specifies the
address, test-account linking purpose, no transaction/payment permission, protocol
version, devnet context, local profile ID, request ID, nonce and exact UTC timestamps. The caller
cannot submit alternate message text or expiry.

The exact UTF-8 message is verified using Node's Ed25519 verification and the
Solana public key encoded as an Ed25519 SPKI key. A signature must be exactly 64
bytes in canonical base64 (88 characters); wallet adapters usually return bytes,
so the frontend converts those bytes to base64, not base58, before submission.
Only the challenge owned by the current customer can be confirmed. Issuing a new
challenge invalidates that customer's prior one. A future, expired, replaced or
already consumed challenge cannot be used.

## Frontend flow

1. Sign in through Supabase and create the local PF profile if missing.
2. Connect a Solana wallet and obtain its public key. Ask the API for a challenge.
3. Display the account-linking purpose. Call the adapter's signMessage with
   `new TextEncoder().encode(data.message)` after the user's explicit wallet action.
4. Base64-encode the returned signature bytes and POST challenge_id/signature_base64
   with the **same authenticated account**. If account/address changed in between,
   discard the challenge and restart. Never send a seed phrase or private key.
5. Read GET /v1/me/wallet and the onboarding overview. Never enable a financial
   button based only on wallet proof or a sandbox compliance result.

Wallet denial/cancellation is handled locally by the frontend; no confirmation
request should be sent. A signature is a message signature, not signTransaction
or signAndSendTransaction. Any wallet that cannot sign arbitrary messages needs
an explicit future compatibility path, not a fake verified flag.

## Persistence and concurrency

Migration 020 adds peragus_customer_wallet_challenges (one current challenge per
customer) and peragus_customer_wallets (one immutable binding per customer and one
customer per address). Both enforce test environment, enable RLS and revoke
public/anon/authenticated grants. Wallets enforce devnet context. Public wallet
addresses and proof metadata are associated personal data, even though no private
key is stored. Do not expose them to other customers.

Confirmation consumes the exact challenge and inserts the unique wallet binding
in a single Postgres transaction with a bounded lock timeout. CAS conditions check
customer, challenge ID, address, non-consumption and time validity (including an
expiry check against the database clock at consumption); a replaced
challenge or racing second confirmation cannot create a second binding. Failure
to insert rolls back consumption. No implicit replacement, ownership transfer,
unlink, override or reuse by another account is exposed.

The binding retains the exact public message/signature and challenge ID for audit,
so an overwritten challenge row does not erase its proof. Proof signature/message
are never returned by the wallet-read or overview API. The read path selects only
public address and verification time. No secret key, seed or signed transaction is
accepted or persisted. There is no foreign key from proof_challenge_id to the
mutable current challenge ID; the binding deliberately keeps immutable evidence
independently of that single current challenge slot.

After successful consumption, repeating confirmation is a 409, not another
success. If the response was lost, use GET to recover the saved binding. If the
transaction failed before commit, the same unexpired challenge can be retried.
There is no autonomous refresh, wallet rotation or cleanup job in this milestone;
the current-challenge table is bounded by one row per profile.

## Overview and errors

The existing onboarding status now includes wallet public metadata or null,
`actions_enabled.wallet`, and WALLET_OWNERSHIP_REQUIRED when no binding is saved.
This remains a stored observation with operations_enabled=false. It does not
assert a funded wallet, live network eligibility, economic ownership or continued
control after key compromise/rotation.

Error families: AUTH_REQUIRED (401), existing account/auth gates, PF required
(403), CUSTOMER_WALLET_LINKING_DISABLED (503), VALIDATION_ERROR or
WALLET_ADDRESS_INVALID (400), WALLET_SIGNATURE_INVALID (403), and 409 for invalid,
expired, used challenge, existing wallet or binding conflict. Unexpected storage
failures return generic CUSTOMER_WALLET_LINKING_UNAVAILABLE (503); read the binding
before retrying after an uncertain response. No other customer's identity is
returned when an address conflicts.

## Rollout and validation

Apply migration 020 on pinned staging **before merging**, because the already
active consolidated overview will join the new wallet table even while wallet
linking is disabled. Build, merge into develop and deploy the API, then temporarily
enable CUSTOMER_WALLET_LINKING_ENABLED. Keep all provider mutation, simulation and
financial flags disabled; the webhook and read-only overview may remain active.

Automated tests exercise genuine Ed25519 signatures, exact-message/domain/nonce
binding, other keys/customers, invalid addresses/base64, replay, expiry, challenge
replacement, unique wallet binding, atomic rollback, concurrent/stale confirmation,
authentication, strict parsing, RLS and network constraints. Tests do not provision
wallets or send funds. For external API acceptance use a disposable generated
in-memory test key and explicitly label it as such. Real browser/wallet-adapter
integration (including Jupiter) still requires frontend acceptance; backend tests
are not evidence that a user's browser wallet is connected.
