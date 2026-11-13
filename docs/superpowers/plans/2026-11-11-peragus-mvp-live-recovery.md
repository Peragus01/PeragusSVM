# Peragus MVP Live Recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir que o mesmo código execute a jornada Pix → USDT em `test`/devnet (staging) e em `live`/Mainnet (produção), com trava de câmbio, verificação on-chain, aceite jurídico no backend e controles do operador único, até a transação interna de R$1.000.

**Architecture:** Estratégia B da spec. Um módulo `money-environment` deriva o modo de `PERAGUS_DEPLOYMENT_ENV` e substitui todos os literais `test`/`devnet`. O banco ganha guarda de ambiente, status explícito da operação e imutabilidade financeira. Os serviços sandbox existentes são generalizados (não reescritos): o claim antes do POST, `Idempotency-Key` estável e recuperação sem re-POST continuam como estão.

**Tech Stack:** Node 22, TypeScript, Fastify, zod, pg + pg-boss, vitest, PGlite (`@electric-sql/pglite`) para testes SQL, `@solana/web3.js`, Resend; frontend TanStack Start + React + vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-peragus-mvp-recovery-design.md`

## Global Constraints

- Branch de trabalho por fase, base `develop`; PR em inglês para `develop`; promoção `develop → main` só após staging verde. Nenhum merge sem revisão.
- Nunca mover dinheiro real, nunca usar a chave live em staging, nunca imprimir segredos.
- `production → live → solana:mainnet`; `staging → test → solana:devnet`. Nenhuma outra combinação é válida.
- Mint USDT Mainnet: `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` (SPL Token clássico, 6 decimais).
- Genesis hash Mainnet: `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`; Devnet: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.
- Limites padrão: `PURCHASE_MIN_BRL=1000.00`, `PURCHASE_MAX_BRL=1000.00`, `PURCHASE_MAX_OPEN_GLOBAL=1`, uma operação aberta por cliente.
- Operador: MFA fresco ≤ 300 s; intervalo aprovação→execução padrão 900 s; quatro olhos `OPERATOR_FOUR_EYES_ENABLED=false`.
- Valores monetários sempre em string decimal/`bigint` (unidades de 6 casas para USDT, centavos para BRL); nunca `number`/float.
- Novas migrations continuam a numeração de `app/backend/migrations` a partir de `043_`.
- Testes SQL usam o padrão PGlite de `app/backend/test/customer-purchase-intents.test.ts` (aplica todas as migrations em memória).
- Textos ao cliente em pt-BR; avisos de "ambiente de testes" só quando `mode === "test"`.
- Código legado do hackathon (Token-2022, settlement Anchor, demo devnet) não é alterado.

## Review Focus

1. **Configuração cruzada em produção** (chave `ozav_sk_test_` com `PERAGUS_DEPLOYMENT_ENV=production`, RPC devnet em produção): o processo deve recusar subir — teste em Task 2.
2. **Webhook de outro ambiente** (`livemode:true` chegando no staging ou `false` na produção): deve ser ignorado sem alterar estado — teste em Task 8.
3. **Clique duplo / requisição repetida em aprovar ou executar envio**: exatamente um POST à OZAV — teste em Task 10.
4. **Cliente com aceite antigo após troca de versão jurídica**: toda rota de cliente bloqueia com `LEGAL_ACCEPTANCE_REQUIRED` — teste em Task 12.
5. **Transação on-chain com valor menor que o travado, mint diferente ou outro destinatário**: `needs_review`, nunca `delivered_verified` — teste em Task 11.

---

## Fase 1 — Fundação de ambiente

### Task 1: Módulo `money-environment` e chave OZAV por modo

**Files:**
- Create: `app/backend/src/config/money-environment.ts`
- Modify: `app/backend/src/config/env.ts` (regex de `OZAV_API_KEY` em 184-187; nova `SOLANA_USDT_MINT`; superRefine)
- Modify: `app/backend/src/providers/ozav-client.ts:648-652`, `app/backend/src/providers/ozav-sandbox-withdrawal.ts:39-47`
- Test: `app/backend/test/money-environment.test.ts`

**Interfaces:**
- Produces:
  - `type MoneyMode = "test" | "live"`
  - `interface MoneyEnvironment { mode: MoneyMode; network: "solana:devnet" | "solana:mainnet"; ozavKeyPrefix: "ozav_sk_test_" | "ozav_sk_live_"; usdtMint: string; genesisHash: string; walletProofDomain: string; appOrigin: string; explorerCluster: "devnet" | "mainnet-beta" }`
  - `resolveMoneyEnvironment(env: Pick<Env,"PERAGUS_DEPLOYMENT_ENV"|"SOLANA_USDT_MINT">): MoneyEnvironment`
  - `OzavClient` e `OzavSandboxWithdrawalProvider` passam a receber `mode: MoneyMode` nas opções e aceitam somente a chave cujo prefixo corresponde.

- [ ] **Step 1: Write failing tests**
  - `resolves production to live mainnet`: `mode==="live"`, `network==="solana:mainnet"`, `usdtMint==="Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"`, `walletProofDomain==="www.peragus.com.br"`, `appOrigin==="https://www.peragus.com.br"`, `explorerCluster==="mainnet-beta"`.
  - `resolves staging to test devnet`: `mode==="test"`, `network==="solana:devnet"`, `usdtMint` = valor de `SOLANA_USDT_MINT`, `walletProofDomain==="peragussvm-staging.up.railway.app"`.
  - `rejects a production mint other than canonical`: `SOLANA_USDT_MINT` diferente do canônico em produção lança `MONEY_ENVIRONMENT_INVALID`.
  - `OzavClient rejects key of the other mode`: `new OzavClient({apiKey:"ozav_sk_test_x", mode:"live"})` lança; `{apiKey:"ozav_sk_live_x", mode:"live"}` não lança.
- [ ] **Step 2:** `cd app/backend && npx vitest run test/money-environment.test.ts` → FAIL (módulo inexistente).
- [ ] **Step 3: Implement** `resolveMoneyEnvironment` com os valores das Global Constraints; em `env.ts`, `OZAV_API_KEY` aceita `^ozav_sk_(test|live)_[A-Za-z0-9_-]+$` e o superRefine exige prefixo coerente com `PERAGUS_DEPLOYMENT_ENV` (`production`→`live`); `SOLANA_USDT_MINT: z.string().min(32)` obrigatório quando qualquer fluxo de compra estiver habilitado. Atualizar o construtor de `OzavClient` e `OzavSandboxWithdrawalProvider`, e todas as instanciações em `src/server.ts`/`src/worker.ts`, passando `mode`.
- [ ] **Step 4:** rodar o teste novo + `npx vitest run test/ozav-client.test.ts test/ozav-client-write.test.ts test/ozav-sandbox-withdrawal-provider.test.ts` → PASS (ajustar fixtures existentes para passar `mode:"test"`).
- [ ] **Step 5:** `npm run typecheck` → sem erros. Commit `feat: derive money environment from deployment`.

### Task 2: Checagens de boot fail-closed

**Files:**
- Create: `app/backend/src/config/money-environment-boot.ts`
- Modify: `app/backend/src/server.ts` e `app/backend/src/worker.ts` (antes de `listen`/`start`)
- Modify: `app/backend/src/providers/ozav-client.ts:746` (`getCapabilities` retorna `environment: "test" | "live"`)
- Test: `app/backend/test/money-environment-boot.test.ts`

**Interfaces:**
- Consumes: `MoneyEnvironment` (Task 1).
- Produces: `assertMoneyEnvironmentAtBoot(money: MoneyEnvironment, probes: { ozavEnvironment(): Promise<string>; solanaGenesisHash(): Promise<string> }): Promise<void>` — lança `Error` com `code: "MONEY_ENVIRONMENT_MISMATCH"` e `field` ∈ `"ozav" | "solana_rpc"`.

- [ ] **Step 1: Write failing tests**
  - `accepts live with live capabilities and mainnet genesis`.
  - `rejects live when OZAV reports test` → `field==="ozav"`.
  - `rejects live when RPC is devnet` (genesis devnet) → `field==="solana_rpc"`.
  - `rejects test when RPC is mainnet`.
  - `fails closed when a probe throws` → lança `MONEY_ENVIRONMENT_MISMATCH`.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3: Implement**; em `server.ts`/`worker.ts`, quando há `OZAV_API_KEY`, chamar com probes reais (`OzavClient.getCapabilities`, `Connection.getGenesisHash`) e registrar `deployment_configuration_audit` com `money_mode` e `network` (sem segredos). Remover a regra que exigia `SOLANA_RPC_URL` contendo "devnet" (env.ts:333-338) somente para os fluxos de cliente; manter para o demo legado.
- [ ] **Step 4:** rodar → PASS; `npm run typecheck`.
- [ ] **Step 5:** Commit `feat: fail closed on cross-environment money configuration`.

### Task 3: Guarda de ambiente no banco

**Files:**
- Create: `app/backend/migrations/043_money_environment_guard.sql`
- Modify: `app/backend/scripts/migrate.mjs` (grava o ambiente após aplicar migrations)
- Test: `app/backend/test/money-environment-guard.sql.test.ts`

**Interfaces:**
- Produces:
  - Tabela `peragus_database_environment(singleton boolean primary key default true check(singleton), environment text not null check(environment in ('test','live')), recorded_at timestamptz not null default now())`.
  - Função/trigger `peragus_enforce_row_environment()` `before insert or update` nas tabelas `peragus_customer_wallet_challenges`, `peragus_customer_wallets`, `peragus_customer_indicative_quotes`, `peragus_customer_purchase_intents`, `peragus_customer_sandbox_pix`, `peragus_customer_withdrawal_requests`, `peragus_withdrawal_operator_approvals`, `peragus_sandbox_withdrawal_executions`, `peragus_customer_refund_requests`, `peragus_customer_reconciliation`: rejeita (`raise exception 'ENVIRONMENT_MISMATCH'`) quando `new.environment` ≠ ambiente registrado ou quando não há registro.
  - CHECKs trocados: `environment in ('test','live')`; colunas de rede (`network`, `wallet_proof_network`, `proof_network`) passam a `in ('solana:devnet','solana:mainnet')` mais `check ((environment='test' and <rede>='solana:devnet') or (environment='live' and <rede>='solana:mainnet'))`. Remover os `default 'test'`/`default 'solana:devnet'` (todo insert passa a informar explicitamente).
  - `migrate.mjs`: após migrar, `insert into peragus_database_environment(environment) values ($1) on conflict do nothing`, com `$1` derivado de `PERAGUS_DEPLOYMENT_ENV`; se já existir com valor diferente, aborta com `DATABASE_ENVIRONMENT_CONFLICT`.

- [ ] **Step 1: Write failing tests (PGlite)**
  - `rejects inserts before the database environment is recorded`.
  - `accepts test rows in a test database and rejects live rows`.
  - `accepts live+mainnet in a live database and rejects live+devnet`.
  - `existing rows created as test remain readable` (insert antes da 043 com ambiente test, aplicar 043 com ambiente test, select ok).
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3: Implement** a migration e o passo no `migrate.mjs`. Atualizar os repositórios Postgres que dependiam dos defaults para passar `environment` e rede de `MoneyEnvironment` (`postgres-customer-wallet.ts`, `postgres-customer-quotes.ts`, `postgres-customer-purchase-intents.ts`, `postgres-customer-sandbox-pix.ts`, `postgres-customer-withdrawal-requests.ts`, `postgres-withdrawal-operator-approvals.ts`, `postgres-sandbox-execution.ts`, reembolsos e reconciliação). O JOIN de aprovação em `postgres-withdrawal-operator-approvals.ts:22` usa a rede do ambiente, não `'solana:devnet'` literal.
- [ ] **Step 4:** `npx vitest run` (suíte inteira do backend) → PASS.
- [ ] **Step 5:** Commit `feat: enforce one money environment per database`.

### Task 4: Remover literais de teste e isolar rotas de simulação

**Files:**
- Modify: `app/backend/src/app.ts:163-172` (capabilities usa `MoneyEnvironment`: `environment`, `network`, `real_purchase: mode==="live"`)
- Modify: `app/backend/src/wallets/customer-wallet.ts:3-4,25-27` (`CustomerWalletService` recebe `MoneyEnvironment`; mensagem usa `walletProofDomain`, `network` e "Peragus account" sem "TEST" em live)
- Modify: `app/backend/src/onboarding/customer-verification-service.ts:20,28`, `app/backend/src/invites/pilot-invites.ts:435`, `app/backend/src/invites/invite-email-template.ts:10-15`
- Modify: registro de rotas `simulate`/sandbox em `app/backend/src/app.ts` (só quando `mode==="test"`)
- Modify: `app/frontend/src/routes/cadastro.tsx:43-46` (aceita `environment` igual ao informado pelo backend), `app/frontend/src/lib/peragus/customer-copy.ts` (avisos de teste condicionados ao modo)
- Test: `app/backend/test/app.test.ts`, `app/backend/test/customer-wallet.test.ts`, `app/backend/test/pilot-invites.test.ts`, `app/frontend/src/test/customer-mvp.test.tsx`

**Interfaces:**
- Consumes: `MoneyEnvironment`.
- Produces: `GET /v1/me/capabilities` (rota existente que responde em app.ts:163) com `{environment, network, real_purchase}`; frontend `useMoneyMode(): "test" | "live"` em `app/frontend/src/lib/peragus/config.ts`.

- [ ] **Step 1: Write failing tests**
  - `live capabilities report mainnet and real_purchase true`.
  - `live wallet proof message names www.peragus.com.br and solana:mainnet and omits TEST`.
  - `simulate routes are not registered in live` (`POST /v1/me/sandbox-pix/:id/simulate` → 404).
  - `live invite email omits the test-environment banner`.
  - Frontend: `signup accepts a live invitation when backend mode is live`; `test banner hidden in live`.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** `npm test` no backend e no frontend → PASS; `npm run lint` no frontend.
- [ ] **Step 5:** Commit `feat: drive customer-facing environment from money mode`.

---

## Fase 2 — Compra com câmbio travado

### Task 5: Limites, concorrência, status e imutabilidade da operação

**Files:**
- Create: `app/backend/migrations/044_purchase_operation_status.sql`
- Create: `app/backend/src/purchases/operation-status.ts`
- Modify: `app/backend/src/config/env.ts` (`PURCHASE_MIN_BRL`, `PURCHASE_MAX_BRL`, `PURCHASE_MAX_OPEN_GLOBAL`)
- Modify: `app/backend/src/quotes/customer-quotes.ts:10-17` (faixa configurada)
- Modify: `app/backend/src/repositories/postgres-customer-purchase-intents.ts`
- Test: `app/backend/test/operation-status.test.ts`, `app/backend/test/customer-purchase-intents.test.ts`, `app/backend/test/customer-quotes.test.ts`

**Interfaces:**
- Produces:
  - `type OperationStatus = "quoted"|"accepted"|"awaiting_pix"|"pix_confirmed"|"converted"|"awaiting_approval"|"approved"|"sending"|"sent"|"delivered_verified"|"expired"|"failed"|"needs_review"|"refund_pending"|"refunded"`
  - `canTransition(from: OperationStatus, to: OperationStatus): boolean` e `OPEN_STATUSES: ReadonlySet<OperationStatus>` (todos exceto `delivered_verified`, `expired`, `failed`, `refunded`).
  - Coluna `status` em `peragus_customer_purchase_intents` (default `accepted`), coluna `status_changed_at`, tabela append-only `peragus_operation_status_events(purchase_id, from_status, to_status, actor, reason, created_at)`.
  - Trigger SQL espelhando `canTransition`; trigger de imutabilidade que rejeita update de `quote_id`, valores BRL/USDT travados, `facility_terms_version` e carteira.
  - Índice parcial único: uma operação com status em `OPEN_STATUSES` por `customer_id`.
  - `normalizeQuoteBrl(value: string, limits: {minCents: bigint; maxCents: bigint}): string`, erro `QUOTE_AMOUNT_OUT_OF_RANGE`.
  - `PurchaseIntentError` ganha `PURCHASE_CUSTOMER_HAS_OPEN_OPERATION` e `PURCHASE_GLOBAL_CAPACITY_REACHED` (contagem global sob `pg_advisory_xact_lock` dentro do `record`).

- [ ] **Step 1: Write failing tests**
  - `canTransition` cobre a cadeia feliz da spec e recusa `sending → awaiting_pix`, `delivered_verified → *`.
  - SQL: `rejects an invalid transition`, `rejects updating the locked USDT amount`, `rejects a second open operation for the same customer`, `rejects a second open operation globally when cap is 1`.
  - `quote 999.99 and 1000.01 are rejected and 1000.00 accepted with default limits`.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** suíte do backend → PASS.
- [ ] **Step 5:** Commit `feat: explicit purchase status with limits and immutability`.

### Task 6: Cotação com trava de câmbio

**Files:**
- Create: `app/backend/migrations/045_quote_rate_lock.sql` (colunas `facility_terms_version text`, `locked_usdt_amount numeric(20,6)` em `peragus_customer_indicative_quotes`)
- Modify: `app/backend/src/providers/ozav-client.ts:1170` (`createCustomerIndicativeQuote` aceita `{facilityPreview: boolean}` e retorna `facility?: {termsVersion: string}`)
- Modify: `app/backend/src/quotes/customer-quotes.ts`, `app/backend/src/repositories/postgres-customer-quotes.ts`
- Test: `app/backend/test/customer-quotes.test.ts`, `app/backend/test/ozav-client-write.test.ts`

**Interfaces:**
- Produces: `CustomerQuoteRecord` ganha `facilityTermsVersion: string | null` e `lockedUsdtAmount: string`; erro `QUOTE_RATE_LOCK_UNAVAILABLE`.

- [ ] **Step 1: Write failing tests**
  - `live quote requests facility_preview and stores terms_version` (corpo enviado contém `"facility_preview":true`).
  - `live quote without facility block is refused with QUOTE_RATE_LOCK_UNAVAILABLE and nothing is stored`.
  - `test quote never sends facility_preview` (a OZAV recusa com chave de teste).
  - `AMOUNT_BELOW_MINIMUM from OZAV maps to QUOTE_AMOUNT_OUT_OF_RANGE`.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** rodar → PASS.
- [ ] **Step 5:** Commit `feat: request OZAV rate lock on live quotes`.

### Task 7: Transfer Pix live com trava e instruções de pagamento

**Files:**
- Modify: `app/backend/src/providers/ozav-client.ts:1312-1356` (`createCustomerPixTransfer` envia `facility_terms_accepted:true` e `facility_terms_version` quando `mode==="live"`; mapeia `FACILITY_LOCK_UNAVAILABLE`/`client_not_exempt` para erro não-ambíguo)
- Modify: `app/backend/src/purchases/customer-sandbox-pix.ts` (classe passa a `CustomerPixService`, mesmo arquivo; `simulatePayment` só registrado em test; transições `accepted → awaiting_pix`, recusa de trava → `failed`)
- Modify: `app/backend/src/routes/customer-sandbox-pix.ts` (manter o caminho `v1/me/sandbox-pix` e adicionar alias `v1/me/pix`; rota de simulação só em test)
- Test: `app/backend/test/customer-sandbox-pix.test.ts`, `app/backend/test/customer-pix-provider.test.ts`

**Interfaces:**
- Consumes: `canTransition`, `CustomerQuoteRecord.facilityTermsVersion`.
- Produces: `pixView` inclui `payment_instructions: {br_code: string; expires_at: string} | null` e `status: OperationStatus`.

- [ ] **Step 1: Write failing tests**
  - `live transfer carries facility_terms_accepted and version and the Idempotency-Key peragus-pix-<uuid>`.
  - `rate lock refusal marks the operation failed and returns no payment instructions`.
  - `ambiguous create keeps the claim and never re-posts` (já existe para sandbox — estender ao live).
- [ ] **Step 2:** rodar → FAIL. **Step 3:** implementar. **Step 4:** rodar → PASS.
- [ ] **Step 5:** Commit `feat: create live Pix transfers with locked rate`.

### Task 8: Webhooks `transfer.*`, reconciliação live e fila de aprovação automática

**Files:**
- Modify: `app/backend/src/routes/customer-webhooks.ts:29-31` (aceita `livemode === (mode==="live")`, ignora o oposto; trata `transfer.updated|completed|failed` e `verification.updated`)
- Modify: `app/backend/src/jobs/customer-reconciliation.ts:20-23` (`assertCustomerReconciliationSafety` aceita o prefixo do modo; o GET é a única fonte de verdade)
- Create: `app/backend/src/purchases/purchase-progression.ts`
- Test: `app/backend/test/customer-webhooks.test.ts`, `app/backend/test/customer-reconciliation.test.ts`, `app/backend/test/purchase-progression.test.ts`

**Interfaces:**
- Produces: `PurchaseProgression.applyTransferObservation(purchaseId: string, observed: {status: OzavTransferStatus; amountUsdt: string | null}): Promise<OperationStatus>` — mapeia `awaiting_payment→awaiting_pix`, `payment_confirmed|converting→pix_confirmed`, `completed→converted→awaiting_approval` (cria o registro em `peragus_customer_withdrawal_requests` com `request_id` derivado `system-<purchaseId>`, idempotente), `failed|expired` sem pagamento → `failed|expired`, `needs_review` → `refund_pending`. Ao entrar em `refund_pending`, cria (idempotente) uma solicitação em `peragus_customer_refund_requests` pelo `ManualRefundService` existente (`app/backend/src/refunds/manual-refunds.ts`); a conclusão do reembolso manual leva a operação a `refunded`.

- [ ] **Step 1: Write failing tests**
  - `refund_pending creates exactly one manual refund request and completing it moves the operation to refunded`.
  - `webhook with livemode opposite to the mode is ignored and changes nothing` (Review Focus 2).
  - `webhook body status is never trusted; state follows GET /v2/transfers/{id}`.
  - `completed transfer moves to awaiting_approval and creates exactly one withdrawal request even when processed twice`.
  - `needs_review after payment moves to refund_pending and raises an alert record`.
- [ ] **Step 2:** rodar → FAIL. **Step 3:** implementar. **Step 4:** rodar → PASS.
- [ ] **Step 5:** Commit `feat: progress live purchases from OZAV transfer state`.

---

## Fase 3 — Envio e verificação

### Task 9: MFA fresco, intervalo mínimo e quatro olhos configurável

**Files:**
- Modify: `app/backend/src/auth/customer-access.ts:5-9` (`AuthenticatedUser.mfaVerifiedAt?: number`, epoch segundos)
- Modify: `app/backend/src/auth/supabase-authenticator.ts:36-45` (lê `claims.amr`, entrada `{method:"totp", timestamp}`)
- Modify: `app/backend/src/withdrawals/operator-approvals.ts`, `app/backend/src/withdrawals/sandbox-execution.ts:41-47`
- Modify: `app/backend/src/config/env.ts` (`OPERATOR_MFA_MAX_AGE_SECONDS=300`, `OPERATOR_EXECUTION_MIN_DELAY_SECONDS=900`, `OPERATOR_FOUR_EYES_ENABLED=false`)
- Modify: `app/backend/src/app.ts` (nova `GET /v1/admin/operator-status` → `{operator: boolean, mfa_enrolled_required: true}`, sem exigir AAL2) e a tela de enrollment de MFA no frontend (`app/frontend/src/lib/peragus/customer-session-provider.tsx:98-180` e `app/frontend/src/routes/operador.convites.tsx`): o enrollment só é oferecido quando `operator === true`
- Test: `app/backend/test/supabase-authenticator.test.ts`, `app/backend/test/withdrawal-operator-approvals.test.ts`, `app/backend/test/sandbox-withdrawal-execution.test.ts`

**Interfaces:**
- Produces: `requireFreshMfa(user: AuthenticatedUser, maxAgeSeconds: number, now?: number): void` (erro `OPERATOR_MFA_STALE`); execução recusa com `EXECUTION_TOO_EARLY` antes do intervalo e `EXECUTION_REQUIRES_SECOND_OPERATOR` quando quatro olhos está ligado e o executor é o aprovador.

- [ ] **Step 1: Write failing tests**
  - `amr totp older than 300s is stale`; `amr without totp is stale`; `fresh totp passes`.
  - `execution 899s after approval is refused; 900s passes`.
  - `four-eyes enabled refuses same operator; disabled allows`.
  - `operator-status is false for a non-allowlisted user`; frontend `MFA enrollment is not offered to non-operators`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: fresh MFA and execution delay for operator actions`.

### Task 10: Envio live com identificação do destino

**Files:**
- Modify: `app/backend/src/providers/ozav-sandbox-withdrawal.ts` (classe aceita `mode`; novo `identifyDestination(customerId, address, attestedAt)`; `send` usa o USDT travado da operação)
- Modify: `app/backend/src/withdrawals/sandbox-execution.ts` (transições `approved → sending → sent`; chama `identifyDestination` antes de `send`)
- Test: `app/backend/test/ozav-sandbox-withdrawal-provider.test.ts`, `app/backend/test/sandbox-withdrawal-execution.test.ts`

**Interfaces:**
- Consumes: `requireFreshMfa`, `canTransition`.
- Produces: `identifyDestination(customerId: string, address: string, attestedAt: string): Promise<void>` → `POST /v2/customers/{id}/destination-identifications` `{chain:"solana", address, wallet_type:"self_custodied", wallet_attested_ownership_at: attestedAt}`; 409/duplicado tratado como sucesso.

- [ ] **Step 1: Write failing tests**
  - `identifies the destination with the wallet proof timestamp before sending`.
  - `double execute request produces exactly one send POST` (Review Focus 3; duas chamadas concorrentes com o mesmo `withdrawalId`).
  - `send amount equals the locked USDT amount`.
  - `TRAVEL_RULE_REQUIRED keeps the operation in sending with needs_review, never re-posts`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: live USDT send with destination identification`.

### Task 11: Verificador on-chain e conclusão da operação

**Files:**
- Create: `app/backend/src/solana/usdt-delivery-verifier.ts`
- Modify: `app/backend/src/withdrawals/sandbox-execution.ts` (reconcile: `sent → delivered_verified | needs_review`), `app/backend/src/purchases/customer-operation-history.ts:105` (expõe `onchain_delivery_verified` real e `explorer_url`)
- Modify: `app/backend/src/config/env.ts` (`USDT_DELIVERY_TOLERANCE_UNITS=0`)
- Test: `app/backend/test/usdt-delivery-verifier.test.ts`

**Interfaces:**
- Produces: `verifyUsdtDelivery(input: {connection: Pick<Connection,"getParsedTransaction">; txHash: string; mint: string; ownerWallet: string; expectedUnits: bigint; toleranceUnits: bigint}): Promise<{verified: true; deliveredUnits: bigint} | {verified: false; reason: "NOT_FINALIZED"|"TX_FAILED"|"MINT_MISMATCH"|"RECIPIENT_MISMATCH"|"AMOUNT_MISMATCH"}>` — usa `getParsedTransaction(txHash, {commitment:"finalized", maxSupportedTransactionVersion:0})`; o valor entregue é `post − pre` de `postTokenBalances/preTokenBalances` cujo `owner === ownerWallet` e `mint === mint`.

- [ ] **Step 1: Write failing tests** (fixtures de transação parsed)
  - `verifies exact delivery`; `null transaction → NOT_FINALIZED`; `meta.err → TX_FAILED`; `other mint → MINT_MISMATCH`; `credit to another owner → RECIPIENT_MISMATCH`; `credit below expected minus tolerance → AMOUNT_MISMATCH` (Review Focus 5).
  - `operation becomes delivered_verified only when verified; otherwise needs_review`.
  - `test mode with a sandbox hash not found on devnet stays sent and is labelled simulated, never delivered_verified`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: verify USDT delivery on chain before completion`.

---

## Fase 4 — Cadastro, jurídico, sessão e KYC

### Task 12: Aceite jurídico no backend

**Files:**
- Create: `app/backend/migrations/046_customer_legal_acceptances.sql`
- Create: `app/backend/src/legal/legal-acceptance.ts`, `app/backend/src/repositories/postgres-legal-acceptances.ts`
- Modify: `app/backend/src/auth/customer-access.ts` (gate antes das rotas de cliente), `app/backend/src/config/env.ts` (`LEGAL_REQUIRED_DOCUMENTS`)
- Test: `app/backend/test/legal-acceptance.test.ts`

**Interfaces:**
- Produces:
  - Tabela append-only `peragus_customer_legal_acceptances(id uuid, user_id uuid, customer_id uuid, document text check(document in ('terms','privacy','refund')), version text, sha256 text, accepted_at timestamptz, ip inet, user_agent text)` com trigger que proíbe update/delete.
  - `LEGAL_REQUIRED_DOCUMENTS` = JSON `{"terms":{"version":"draft-0.9-2026-11-03","sha256":"<hex>"},"privacy":{...},"refund":{...}}` (o executor calcula os hashes dos HTMLs portados na Task 13).
  - `POST /v1/me/legal-acceptances` body `{documents: [{document, version}]}` → grava somente versões iguais às exigidas, senão `LEGAL_VERSION_MISMATCH`.
  - `GET /v1/me/legal-acceptances` → `{required: [...], missing: [...]}`.
  - Toda outra rota `/v1/me/*` responde 403 `LEGAL_ACCEPTANCE_REQUIRED` enquanto `missing` não estiver vazio.

- [ ] **Step 1: Write failing tests**
  - `customer without acceptance gets LEGAL_ACCEPTANCE_REQUIRED on quotes, onboarding and purchase routes`.
  - `acceptance of current versions unlocks routes`.
  - `changing a required version locks routes again` (Review Focus 4).
  - `acceptance of an old version is refused`; `acceptance rows cannot be updated or deleted`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: server-side legal acceptance gate`.

### Task 13: Aceite jurídico no frontend (porte da PR #73)

**Files:**
- Port from `origin/feat/legal-documents-registration-gate` (via `git checkout <branch> -- <file>`, sem merge): `app/frontend/public/legal/termos-de-uso.html`, `politica-de-privacidade.html`, `politica-de-reembolso.html`, `app/frontend/src/lib/peragus/legal-acknowledgement.ts`
- Modify: `app/frontend/src/routes/cadastro.tsx` (checkboxes e botão desabilitado), tela de compra/Pix (link da política de reembolso antes do QR), novo passo pós-login quando o backend responde `LEGAL_ACCEPTANCE_REQUIRED`
- Test: `app/frontend/src/test/legal-acceptance.test.tsx`

**Interfaces:**
- Consumes: `GET/POST /v1/me/legal-acceptances` (Task 12).

- [ ] **Step 1: Write failing tests**
  - `create account button stays disabled until terms and privacy are checked`.
  - `LEGAL_ACCEPTANCE_REQUIRED redirects to the acceptance step and posting it resumes navigation`.
  - `refund policy link is visible before payment instructions`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar (não portar `legal-signup.server.ts`: o gate de verdade é o backend). **Step 4:** `npm test && npm run lint` → PASS.
- [ ] **Step 5:** Commit `feat: legal acceptance screens backed by the API gate`.

### Task 14: Sessão persistente com refresh

**Files:**
- Modify: `app/frontend/src/lib/peragus/customer-session-provider.tsx:46-60`, `app/frontend/src/lib/peragus/customer-session-auth.ts`
- Test: `app/frontend/src/test/customer-session-persistence.test.tsx`

**Interfaces:**
- Produces: `refreshSession(refreshToken: string): Promise<SessionTokens>` (`POST /auth/v1/token?grant_type=refresh_token`); armazenamento em `sessionStorage` chave `peragus.session`.

- [ ] **Step 1: Write failing tests**: `session survives reload`; `expired access token is refreshed once`; `failed refresh clears storage and logs out`; `logout clears sessionStorage`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: persist customer and operator sessions per tab`.

### Task 15: KYC live por sessão hospedada

**Files:**
- Modify: `app/backend/src/onboarding/customer-verification-service.ts:49-88` (em `live`, `start` retorna `session_url`; `simulate` só em test)
- Modify: `app/backend/src/routes/customer-webhooks.ts` (`verification.updated` dispara `refresh`)
- Modify: tela de verificação do frontend (`app/frontend/src/components/peragus/customer-onboarding.tsx`, redireciona para `session_url`; texto "documentos sintéticos" só em test)
- Test: `app/backend/test/customer-verification.test.ts`, `app/frontend/src/test/customer-onboarding-journey.test.tsx`

**Interfaces:**
- Produces: resposta de `start` `{status, session_url: string | null, sandbox_only: boolean}`; em live, `session_url` ausente → erro `VERIFICATION_SESSION_UNAVAILABLE`.

- [ ] **Step 1: Write failing tests**: `live start returns the hosted session_url`; `live without session_url fails with VERIFICATION_SESSION_UNAVAILABLE`; `verification.updated triggers a GET refresh`; frontend `redirects to session_url in live`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: hosted OZAV verification in live mode`.

---

## Fase 5 — Operação

### Task 16: Kill switches em runtime

**Files:**
- Create: `app/backend/migrations/047_runtime_controls.sql`, `app/backend/src/operations/runtime-controls.ts`
- Modify: serviços de cotação, aceite, Pix, execução de envio e onboarding (checagem na mesma transação)
- Test: `app/backend/test/runtime-controls.test.ts`

**Interfaces:**
- Produces: tabela `peragus_runtime_controls(key text primary key check(key in ('new_operations','usdt_sends','onboarding')), enabled boolean not null default false, updated_by uuid, updated_at timestamptz)` + eventos append-only; `assertControlEnabled(client: PoolClient, key: RuntimeControlKey): Promise<void>` (`select … for share`, erro `OPERATIONS_PAUSED`); `GET/PUT /v1/admin/runtime-controls` com `requireFreshMfa`.

- [ ] **Step 1: Write failing tests**: `paused new_operations refuses quotes and acceptance`; `paused usdt_sends refuses execution but leaves approved operations untouched`; `resuming lets the same operation proceed`; `change is audited and needs fresh MFA`; `default after migration is disabled (fail closed)`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: runtime kill switches for money paths`.

### Task 17: Alertas, e-mail à pessoa de confiança e revisão diária

**Files:**
- Create: `app/backend/migrations/048_operator_notifications.sql`, `app/backend/src/operations/operator-notifications.ts`, `app/backend/src/operations/daily-review.ts`, `app/backend/src/jobs/stuck-operations.ts`
- Modify: `app/backend/src/worker.ts` (fila `operator-notifications` e cron `stuck-operations` a cada 5 min), `app/backend/src/config/env.ts` (`OPERATOR_ALERT_EMAIL`, `TRUSTED_ALERT_EMAIL`)
- Test: `app/backend/test/operator-notifications.test.ts`, `app/backend/test/daily-review.test.ts`

**Interfaces:**
- Produces:
  - Outbox `peragus_operator_notifications(id, kind, purchase_id, payload_hash, status, attempts, created_at)` com o mesmo padrão de idempotência do outbox de convites (`Idempotency-Key` estável, tentativa registrada antes do HTTP, `uncertain` sem retry).
  - `kind` ∈ `approval|execution|needs_review|refund_pending|runtime_control_changed|stuck_operation|webhook_signature_invalid|reconciliation_mismatch`; destinatários: operador e pessoa de confiança.
  - Limites de "parado": `awaiting_pix` além da expiração do Pix, `sending` > 30 min, `sent` > 30 min sem verificação.
  - `peragus_daily_reviews(day date primary key, reviewed_by uuid, reviewed_at timestamptz)`; `POST /v1/admin/daily-reviews` (MFA fresco); `assertPreviousDayReviewed(client, now)` chamado junto de `assertControlEnabled('new_operations')` — bloqueia com `DAILY_REVIEW_REQUIRED` quando houve operação no dia anterior sem revisão.

- [ ] **Step 1: Write failing tests**: `approval enqueues one notification per recipient`; `retrying the worker does not send twice`; `sending for 31 minutes raises stuck_operation once`; `new operation blocked when yesterday had operations and no review`; `no block when yesterday had no operations`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: operator alerts, trusted-person notices and daily review`.

### Task 18: Rota `/ready`

**Files:**
- Modify: `app/backend/src/app.ts` (nova rota), `app/backend/src/database/readiness.ts`
- Test: `app/backend/test/app.test.ts`

**Interfaces:**
- Produces: `GET /ready` → 200 `{status:"ready", checks:{database:"ok", queue:"ok", ozav:"ok"}}` ou 503 com o check que falhou; nunca expõe mensagens de erro do provedor.

- [ ] **Step 1:** testes `ready is 503 when the database probe fails`, `ready is 503 when OZAV capabilities fails`, `ready is 200 when all pass`.
- [ ] **Step 2:** FAIL. **Step 3:** implementar. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat: readiness endpoint`.

### Task 19: Higiene de produção e runbooks (requer aprovação humana em cada item)

**Files:**
- Create: `docs/operations/operator-mfa-reset.md`, `docs/operations/backup-and-restore.md`, `docs/operations/internal-transaction-runbook.md`
- Modify: `.github/workflows/ci.yml` (adicionar `push: branches: [main, develop]`)

Passos operacionais — cada um só com "sim" explícito do responsável, registrando evidência no runbook:

- [ ] **Step 1:** CI em push para `develop`; abrir PR; confirmar run verde.
- [ ] **Step 2:** Ruleset da `main` (PR obrigatória, checks `Backend` e `Frontend`, sem force-push). Evidência: resposta da API de branch protection.
- [ ] **Step 3:** Merge da PR #104 (issuer do MFA) após CI verde.
- [ ] **Step 4:** Vercel produção: remover `POSTGRES_*`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWT_SECRET`; confirmar que o build continua verde. Railway produção (API): remover `OZAV_QUOTE_ID`, `OZAV_TRANSFER_ID`, `OZAV_SOLANA_ADDRESS`.
- [ ] **Step 5:** Supabase Auth produção: conferir SMTP (Resend) e Site URL/redirect URLs; ligar leaked-password protection. Evidência: captura do painel.
- [ ] **Step 6:** Backup: dump semanal agendado para armazenamento externo e **um teste de restauração** em banco descartável, documentado em `backup-and-restore.md`.
- [ ] **Step 7:** `operator-mfa-reset.md`: procedimento de reset de fator pelo painel do Supabase com registro em auditoria.
- [ ] **Step 7b:** Monitor externo de uptime em `/health` e `/ready` da produção, alertando o operador. Evidência: captura da configuração.
- [ ] **Step 8:** Commit `docs: production hygiene and operator runbooks`.

---

## Fase 6 — Validação e liberação

### Task 20: Smoke ponta a ponta em staging

**Files:**
- Create: `app/backend/scripts/staging-e2e-smoke.mjs`
- Test: `app/backend/test/staging-e2e-smoke.test.ts` (somente a guarda: o script recusa rodar com `PERAGUS_DEPLOYMENT_ENV=production` ou chave `ozav_sk_live_`)

- [ ] **Step 1:** teste da guarda → FAIL. **Step 2:** implementar a guarda e o roteiro: convite → cadastro → aceite jurídico → KYC simulado → carteira devnet → cotação R$1.000 → Pix simulado → `awaiting_approval` → aprovação → (aguarda intervalo configurado para 0 em staging) → execução → reconciliação; imprime o status final e os IDs (sem segredos).
- [ ] **Step 3:** teste → PASS. **Step 4:** rodar contra o staging após deploy de `develop`; anexar a saída ao PR de promoção.
- [ ] **Step 5:** Commit `test: staging end-to-end smoke script`.

### Task 21: Evidências OZAV live e liberação em produção (requer aprovação humana)

**Files:**
- Create: `app/backend/scripts/ozav-live-capabilities.mjs` (somente `GET /v2/capabilities`; recusa qualquer outro método)
- Modify: `docs/operations/internal-transaction-runbook.md`

- [ ] **Step 1:** teste do script: `refuses non-GET`, `prints entitlements and scopes but never the key`. Implementar. Commit `feat: read-only OZAV live capability probe`.
- [ ] **Step 2 (humano):** responsável configura a chave live no Railway produção; executar o probe; arquivar a saída e as respostas escritas da OZAV (seção 6 da spec).
- [ ] **Step 3 (humano):** promover `develop → main`; deploy com todos os `peragus_runtime_controls` desligados; confirmar `deployment_configuration_audit` com `money_mode=live`, `network=solana:mainnet` e `/ready` 200; ligar o envio do `onboarding-email-worker` em produção (hoje `sending_enabled=false`).
- [ ] **Step 4 (humano):** transação interna de R$1.000 conforme o runbook, ligando `onboarding`, depois `new_operations`, depois `usdt_sends` apenas durante a operação; coletar o pacote de evidências da spec (IDs OZAV, `tx_hash`, Explorer, conciliação, auditoria, e-mails, capturas).
- [ ] **Step 5 (humano):** revisão Go/No-Go (16 critérios da spec seção 7) registrada no runbook. NO-GO se qualquer item faltar.
