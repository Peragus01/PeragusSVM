# Premium customer experience

For the current functional onboarding/purchase journey, see [invited-customer-journey.md](invited-customer-journey.md). This document records the preceding milestone.

## Outcome and scope

The customer application now emphasizes buying USDT with BRL, reviewing available costs and following transaction progress. It uses Peragus's supplied official mark, deep black/navy surfaces, electric blue actions, restrained cyan accents and green only for confirmed positive states. The primary navigation is Home, Buy USDT, My wallet, History and My account (Portuguese UI labels).

This is a frontend refresh, based on `feat/frontend-mvp-integration` at `f052770f5661df29850bad24b69ff5e955c3112a` (PR #46 merged). Production branches, backend contracts, migrations, secrets and operational flags were not changed. GitHub documentation and change descriptions are in English; customer copy is in Portuguese.

## Audit findings

- The old purchase layout gave internal records and onboarding metadata more visual weight than BRL and USDT amounts.
- Local profile `draft` is distinct from approved stored identity checks. It must not be promoted into KYC approval or a financial permission.
- Quote and purchase response validators explicitly require test/non-executable markers. There is no authoritative live capability response consumed by this client. Removing the test warning or introducing a frontend environment selector would misrepresent the current contracts.
- `POST /v1/me/quotes` and `GET /v1/me/quotes/:id` return indicative saved observations, not executable prices. Re-reading a quote does not refresh it. Null expiry does not reserve a price indefinitely.
- `POST /v1/me/purchase-intents` and its GET resource save a test record. The body remains exactly `request_id` and `quote_id`; the server derives the amount and destination. No browser wallet address, fee or approval is submitted.
- Backend `/v1/me/sandbox-pix` resources and reconciliation exist, but are not exposed by the current purchase proxy/UI. Test Pix is not a live payment capability.
- Existing history and withdrawal-result reads support transaction status and reported gross/net/deducted amounts, but explicitly do not confirm mainnet delivery. There is no verified signature in these contracts; therefore no invented explorer link.
- Wallet Standard connection is restricted to Solana Devnet. A connection is neither an ownership proof nor a change to the account-bound destination.

## Implementation

- Shared official branding in public header, sidebar, auth pages and favicon. `public/peragus-mark.png` is an unchanged copy of the user-supplied `P em PNG(1).png`; no logo was generated. The supplied raster is also used as the favicon; a small-size official favicon would improve its sharpness.
- Shared `premium.css`: typography, surfaces, buttons, input focus/validation, one-way conversion card, status colors, transaction progression, mobile cards and bottom navigation. It adds no animation library or production dependency.
- Motion uses short eased entrances, staggered cards, button anticipation/press response, progressive public-section reveal, skeleton loading and expanding secondary details. `prefers-reduced-motion` disables animation and transition effects. Public content stays visible without IntersectionObserver support.
- Purchase card displays BRL input, estimated USDT, fixed Solana identification, available backend deduction before conversion, unknown delivery fee/net amount, expiry and record confirmation. There is deliberately no fake token/network selector or instant swap action.
- Existing request IDs, synchronous duplicate guard, storage-before-write, explicit retries, GET recovery and stale-session cancellation are preserved. An expired new record is disabled and the existing handler still checks the current clock before writing.
- Optional existing API response fields are validated before display: `exchange_conditions.amount_deducted` and `destination.wallet_address/proof_network`. Unknown costs stay unknown, not zero. The deduction is not presented as all-in fees.
- A connected browser wallet is labeled separately from the backend-derived destination. The saved destination appears only when returned by the record response; no new destination-edit API is invented.
- Dashboard replaces raw technical metric cards with a purchase entry point, wallet/account shortcuts, recent purchases and optional identity details. No balances or financial totals are fabricated.
- History preserves loaded-record-only filters and pagination. Mobile rows become cards, with ID and destination in expandable references. Details add a progress timeline and retain refund functionality and secondary technical data.
- `USDT entregue` requires explicit verified delivery, mainnet execution and a non-test environment. Provider completion never produces that label. Current strict read contracts remain test-only and reject live-shaped responses.
- Mobile navigation retains Escape, focus containment, focus restoration, background inertness and scroll locking. Touch actions use 44px or larger targets where applicable.

### Changed areas

| Area                     | Files                                                                                                                                                                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and motion      | `public/peragus-mark.png`, `src/premium.css`, `src/public-home.css`, `src/components/peragus/customer-ui.tsx`, `src/components/peragus/motion.ts`, `src/routes/__root.tsx`                                                                                                        |
| Purchase and status      | `src/routes/app.comprar-usdt.tsx`, `src/lib/peragus/purchase.ts`, `src/components/peragus/purchase-timeline.tsx`, `src/components/peragus/customer-operations.tsx`                                                                                                                |
| Customer pages           | `src/routes/app.index.tsx`, `app.carteira.tsx`, `app.operacoes.index.tsx`, `app.operacoes.$id.tsx`, `app.minha-conta.tsx`, `app.auditoria.tsx`                                                                                                                                    |
| Public and identity copy | `src/routes/index.tsx`, `src/components/peragus/onboarding-evidence.tsx`, `src/lib/peragus/onboarding-status.ts`, `src/lib/peragus/customer-copy.ts`; auth pages inherit shared design; `login.tsx` and `recuperar-senha.tsx` add busy feedback and customer-facing recovery copy |
| Regression coverage      | `src/test/premium-purchase.test.tsx`, updated purchase-flow, customer-UX, onboarding-status and customer-MVP tests                                                                                                                                                                |

## Validation

- TypeScript check and production build.
- 101 tests in 15 files: existing proxy, auth, session, decimal normalization, duplication, persistence/recovery, expiry, refund and operator coverage plus delivery-honesty and optional response-field checks.
- Local Chromium, device scale 1, desktop 1440px and mobile 390px, plus purchase/home overflow checks at 320px and purchase checks at 768/1024px: public home, login, dashboard, quote, record confirmation, history, details and logout/back guard. No page overflow or JavaScript errors in this synthetic-response run. Keyboard checks covered mobile-menu focus containment, Escape and focus restoration. Primary button white text uses a darker blue surface (~4.9:1 contrast); electric blue remains an accent.
- Browser traffic intercepted locally. The only business POSTs were `/api/v1/me/quotes` and `/api/v1/me/purchase-intents`. No staging writes, provider actions or real payments were performed.
- The build used synthetic public Auth configuration for browser QA; no environment files or credentials were committed.

## Before live activation

The visual system is reusable for production, but **changing flags or credentials alone is not sufficient** for these current test-only contracts. Required follow-up integration work:

1. An authenticated server capability/eligibility contract distinguishing test/live, financial permissions and supported actions. Remove test copy only from verified live capabilities, never browser preferences.
2. A live purchase/payment contract, backend-authorized destination selection/proof, terms, limits, idempotency, expiry and uncertain-outcome recovery. Current test records cannot become live orders.
3. Server-reported fee currency, deduction timing, total payable and net deliverable USDT. Do not derive a final wallet amount from the indicative conversion or assume the OZAV withdrawal fee is zero.
4. Integrate authorized Pix creation, QR/copy-and-paste, confirmation and read-only status/reconciliation through a narrowly scoped proxy. Do not add a client-side payment simulation to the commercial journey.
5. Mainnet wallet support and independently verified delivery/signature before showing delivered status or an explorer link.
6. Real staging acceptance of existing records and disabled-feature responses on a Vercel Preview, then separately reviewed live acceptance. Keep financial flags off for this UX review. No production promotion is included.

Self-service signup/document submission remain unavailable where they were previously gated; the refresh does not invent account creation or KYC approval. There is no custody balance, transfer, bill-payment or affiliate feature.

## Preview review

Create the Preview from this PR's branch so the established Vercel branch/environment settings are applied. Inspect at 100% zoom on desktop and mobile. Check navigation, password visibility, history filters, saved amounts and logout. Financial flags should stay disabled; quote/record runtime acceptance can be done later in a separately controlled sandbox test.
