# Peragus Settlement Control Room

Institutional frontend for creating, signing, reconciling, and auditing Peragus
B2B settlements on Solana Devnet. The interface uses the real Peragus backend
contract and never fabricates settlements, provider events, or signatures.

## Local setup

```bash
cp .env.example .env
npm ci
npm run dev
```

The same-origin `/api/*` server route proxies the browser to the Peragus
backend at `PERAGUS_BACKEND_URL` (default `http://127.0.0.1:3000`) in both
development and production. Start the backend separately from `app/backend`.

All `VITE_*` values are public because Vite includes them in the browser
bundle. Do not place credentials, private keys, database URLs, or payment
instructions in this file.

## Environment

| Variable                          | Purpose                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| `VITE_API_BASE_URL`               | Peragus API base; use `/api` with the local proxy.          |
| `VITE_SOLANA_RPC_URL`             | Solana Devnet JSON-RPC endpoint.                            |
| `VITE_DEMO_CORRIDOR_ID`           | Public demo corridor identifier.                            |
| `VITE_DEMO_RECIPIENT_WALLET`      | Public demo recipient address.                              |
| `VITE_DEMO_PAYOUT_DESTINATION_ID` | Public sandbox payout destination sent only to the backend. |

`PERAGUS_BACKEND_URL` is server-only and must not use the `VITE_` prefix.

## Verification

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run preview
```

The production preview listens on Nitro's default Node port. The Solana
transaction is verified before wallet signing, and a signed transaction is
persisted locally before broadcast so an uncertain network response can be
reconciled without requesting a second signature.

For the interactive hackathon checkout, enable
`PERAGUS_SANDBOX_DEMO_ENABLED=true` only on the backend that uses test
credentials and Solana Devnet. The fictitious QR is intentionally not payable;
the confirmation button advances the provider sandbox and the normal worker
then persists every state transition. The payer signature is never automated.
The backend also prepares the connected acquirer wallet with capped, valueless
Devnet assets so a new judge wallet can complete the demo without terminal
setup.

At the `tokenized` stage, the control room exposes an optional Devnet rollback
proof. It asks the same acquirer wallet to sign a sandbox-only transaction whose
second token leg is guaranteed to fail. The UI then verifies the failed
transaction logs, the absent settlement PDA, and unchanged pre/post token
balances before allowing the normal valid settlement to continue.
