# Invited customer journey and automatic USDT estimates

## Implemented experience

- **Have an invitation** opens a functional registration form. The server validates the email-bound code before Supabase signup; after email confirmation/login, authenticated redemption admits a PF profile atomically. Codes remain in component memory, never URLs, logs or browser storage.
- Authenticated accounts without an admitted profile are directed to registration. Auth account creation does not admit a customer or authorize financial activity.
- Registration immediately presents mandatory onboarding: encrypted personal draft, provider terms and explicit consent, frozen submission, verification start/refresh and separate screening. Saved resources are read on entry so resuming does not automatically create customers or verification sessions. Existing service flags can correctly return unavailable; the UI does not invent enabled capabilities.
- The operator login link is removed from customer login/public navigation. Existing separate operator routes still require server allowlist/MFA/account separation; removing a link is not an access control.
- The purchase page has editable BRL and USDT fields. Only user edits schedule a quote, with 500ms debounce. The last edited field chooses the server request direction. The derived field does not trigger another quote.
- The server, including reverse target pricing, supplies the amounts. Source limits/precision and target decimal precision are checked before requests. No price is inverted in the browser.
- Provider attempts are serialized while newer edits wait; stale results never replace the newest input. Request IDs are persisted before POST. Unknown outcomes block automatic creation and expose explicit same-key/owned-GET recovery. A saved known legacy quote can be recovered without creating a new one. Auth generations discard old responses.
- **Buy USDT** opens review. The current test confirmation is explicitly a record without billing or USDT delivery. It uses the server-bound destination and retains duplicate protection. A saved destination returned by the record must match the reviewed wallet.
- **Connect wallet** uses cyan styling. The inline purchase/wallet flow can request the server challenge, sign the exact message using Wallet Standard and confirm ownership. Connection alone is never a destination change. Existing linked wallets are not overwritten. Mainnet use remains unavailable.
- The server reports quote/record/test-Pix feature availability through `purchase-capabilities`; no frontend environment toggle exists.
- A saved record can explicitly create/recover **test Pix** only when server availability permits. The customer proxy excludes payment/verification simulation. Valid instructions expire locally; payment confirmation comes from the backend. Test conversion is never treated as delivery. Unknown Pix outcomes retain their request ID. Status updates use existing read/reconciliation resources.
- **My account** can save its local display nickname, reload confirmed server identity and display success. Legal name, tax ID and email are read-only with an explanation of confirmation/revalidation requirements. No unsaved-only data editor is presented.

## Operational limits

This is a functional **test** journey, not live activation. No flags were enabled, production credentials added or external customers/payments created.

OZAV's documented test mode does not return a hosted capture URL. The mandatory KYC step can be created/resumed/queried but real document capture cannot be completed with a test key. The interface says this clearly and exposes no approval simulation. Approval is never inferred from a redirect or local profile state.

Available conversion deductions and reported test markup are shown. Delivery fees and net delivered USDT remain **Not reported** when absent from the backend. They are not inferred zero, deducted twice or replaced with a made-up total. Real purchase confirmation remains unavailable with incomplete costs and current test-only contracts.

Invitations still use the backend's existing five-slot pilot. New email-bound invitations need migration 034 and the API-only HMAC key; old UUID-bound invitations remain supported. Email confirmation and delivery depend on the existing Supabase settings. No service-role secret belongs in Vercel client variables.

The Pix QR is displayed only for a bounded PNG data URI; other provider QR formats are not embedded. A valid copy-and-paste code remains usable in the test UI. There is no automatic payment simulation, live Pix execution, withdrawal or explorer link without verified delivery evidence.

## Changed files

- Registration/Auth: `src/routes/cadastro.tsx`, `login.tsx`, `src/lib/peragus/customer-session.tsx`, `src/components/peragus/customer-ui.tsx`.
- Onboarding/account: `customer-onboarding.tsx`, `customer-profile-editor.tsx`, `src/routes/app.minha-conta.tsx`.
- Purchase: `automatic-purchase.tsx`, `customer-pix.tsx`, `src/routes/app.comprar-usdt.tsx`, `src/lib/peragus/purchase.ts`, `purchase-proxy.server.ts`.
- Wallet: `customer-wallet-link.tsx`, `wallet-context.ts`, `Wallet.tsx`, `src/routes/app.carteira.tsx`.
- Narrow proxy/client: `src/lib/peragus/journey-proxy.server.ts`, `journey.ts`, `src/routes/api/$.ts`.
- Shared polish/copy: `src/premium.css`, `src/routes/app.index.tsx`.
- Tests: `automatic-purchase.test.tsx`, `journey-integration.test.tsx`, `customer-onboarding-journey.test.tsx`; retained monetary/proxy cases in `purchase-flow.test.tsx`.

## Verification

TypeScript, production build and **112 tests in 18 files** passed. Coverage includes debounce, both directions, stale responses, serialization, unknown outcome recovery with identical IDs, legacy GET recovery, expired quotes, storage failure, double submission, signup ordering, invalid invitations, mandatory KYC resumption without simulation, nickname persistence and proxy boundaries.

Local Chromium acceptance used intercepted synthetic responses at scale 1. It covered invitation preflight/signup, confirmed login, redemption, personal draft, terms/consent/submission, required verification/screening, wallet message signing, automatic estimates in BRL and USDT, review/test record, disabled Pix, nickname update and logout/back protection. Additional purchase checks covered 320, 390, 768, 1024 and 1440px. No page overflow or JavaScript errors were observed. No real provider/Auth/database operations occurred. Synthetic wallet signatures are fixture-only; the backend's independent cryptographic tests remain responsible for signature validation.

## Preview acceptance

Deploy the backend contract PR first after staging migrations 034–036, then this frontend Preview. Keep financial and simulation flags off. New resource flags may remain off for initial disabled-feature validation. Use a separately authorized synthetic staging run for onboarding/invite/quote/wallet/test-Pix acceptance; real capture and live payments require a separate reviewed activation.

Backend contracts, new secret, migrations, limits and exact staging sequence: `app/backend/docs/integration/invited-customer-journey.md`.
