# Peragus MVP — Recuperação até a primeira transação real (Pix → USDT na Solana Mainnet)

- **Data:** 2026-11-11
- **Status:** design aprovado em conversa, seção por seção; aguardando revisão desta spec escrita
- **Base auditada:** `origin/main` @ `0fefb95` (= `origin/develop` em conteúdo), Railway, Supabase e Vercel em 2026-11-11
- **Abordagem escolhida:** Estratégia B — estabilização seletiva com caminho live paralelo, separado por ambiente

## 1. Objetivo

Transformar o que já foi construído em um MVP financeiro que execute uma compra real e controlada de USDT
(Solana Mainnet) paga via Pix, com segurança e evidências verificáveis. Não é objetivo adicionar
funcionalidades além do necessário para essa primeira transação e para um piloto fechado com clientes convidados.

## 2. Resumo da auditoria (estado em 2026-11-11)

**Conclusão:** o código não executa transação real. Todo o caminho do dinheiro está travado em sandbox/devnet em três camadas:

- Configuração: `OZAV_API_KEY` precisa casar com `^ozav_sk_test_` (`app/backend/src/config/env.ts:184-187`).
- Código: `OzavClient` recusa chave não-test (`app/backend/src/providers/ozav-client.ts:650`); `app/backend/src/app.ts:165-172` fixa `real_purchase:false` e `network:"solana:devnet"`; o cadastro exige convite `test` (`app/frontend/src/routes/cadastro.tsx:45`); a prova de carteira usa domínio de staging e "devnet / TEST account" (`app/backend/src/wallets/customer-wallet.ts:3,26`).
- Banco: CHECKs `environment='test'` e `wallet_proof_network='solana:devnet'` nas migrations 020–027 (ex.: `022_add_customer_purchase_intents.sql:9,17`).

**O que está bom e será reaproveitado:**

- Isolamento prod/staging (refs Supabase distintas, guarda `PERAGUS_DEPLOYMENT_ENV`); deploys alinhados a `main`/`develop`.
- Fluxo OZAV em duas etapas já correto: `fiat_payment → wallet` gerenciada, depois `wallet → crypto_address` com Travel Rule; sem hot wallet da Peragus.
- Claim persistido antes de cada POST, `Idempotency-Key` estável, recuperação por leitura sem re-POST, pg-boss sem retry em dinheiro.
- Prova de controle da carteira por assinatura ed25519 com nonce; destino imutável após o aceite.
- Webhooks com HMAC, janela de tempo e deduplicação; auditoria append-only de aprovações; operador exige AAL2.
- Outbox idempotente de e-mails (Resend).

**Achados de ambiente:** chave OZAV de teste em produção; flags financeiras desligadas em todos os serviços;
0 clientes, 0 convites em produção; `supabase/migrations` (welcome email + pg_cron) aplicadas só em staging;
segredos de Postgres/service-role injetados na Vercel de produção por integração; variáveis
`OZAV_QUOTE_ID`, `OZAV_TRANSFER_ID`, `OZAV_SOLANA_ADDRESS` sobrando na API de produção; `main` e `develop` sem proteção;
CI não roda em push para `develop`; `/ready` inexistente.

**Achados da OZAV API v2 (spec `api-1.json`):** piso de on-ramp BRL de R$1.000 por transfer (`AMOUNT_BELOW_MINIMUM`);
on-ramp só credita carteira gerenciada `ozav_wal_`; envio externo exige Travel Rule; cotação é *floating* e a trava de
câmbio (`facility_terms_*`) exige facility contratado e não existe com chave de teste; `session_url` de KYC só em live e
condicionado às capabilities; eventos `transfer.updated|completed|failed`, `verification.updated`, `requirement.due`.

**Escopo:** o documento "Production MVP — 14 Days" (14/10) não existe no repositório. O `Escopo.pdf` recebido descreve
outro projeto (demo B2B devnet BRL→PYG do hackathon) e não é a base desta spec.

## 3. Decisões aprovadas

| # | Decisão |
|---|---|
| D1 | A Peragus tem chave live da OZAV, com confirmação escrita de on-ramp BRL→USDT na Solana e envio para carteira externa. A evidência técnica (`GET /capabilities`) é exigida antes do Go. |
| D2 | Limite por operação: **R$1.000 fixo** (mínimo = máximo), configurável no servidor para acompanhar a negociação de redução do piso para R$50. Reserva de contingência para reembolso ≥ R$1.000. O lançamento não depende dessa negociação. |
| D3 | Preço com **trava de câmbio da OZAV**. Sem trava aceita, nenhuma transfer é criada e nenhum Pix é exibido (fail closed). |
| D4 | **Operador único**, com controles compensatórios (MFA renovado, intervalo mínimo, alerta a uma pessoa de confiança, revisão diária). Quatro olhos pronto para ser ligado por configuração. |
| D5 | No MVP o cliente é **pessoa física**, cliente direto da OZAV (KYC próprio), com entrega na própria carteira verificada. KYB/PJ e o modelo com comerciantes ficam para a fase 2. |
| D6 | A transação interna é feita por **uma segunda pessoa física de confiança** (CPF, KYC e carteira próprios), que também recebe os alertas. Operador ≠ cliente sem exceção. |
| D7 | O piloto, inclusive com clientes externos, segue com as **minutas jurídicas atuais** — **risco aceito pelo responsável**. Mitigações: aceite versionado e imutável; novo aceite obrigatório quando a versão revisada for publicada; política de reembolso visível antes do pagamento. |
| D8 | **Estratégia B**: o mesmo código roda em staging (`test`/devnet) e produção (`live`/Mainnet); validação em staging e promoção para produção. |

## 4. Design

### 4.1 Modo de ambiente e isolamento

- O modo do dinheiro é **derivado** de `PERAGUS_DEPLOYMENT_ENV`: `production → live`, `staging → test`. Não há nova variável que permita combinações cruzadas.
- Novo módulo `money-environment` (backend) expõe: `environment` (`test|live`), `network` (`solana:devnet|solana:mainnet`), mint USDT permitido, domínio da prova de carteira, origem pública do app. Todos os literais hoje fixos passam a usá-lo (`app.ts:165`, `customer-wallet.ts:3`, `customer-verification-service.ts`, convite e e-mails, `cadastro.tsx:45`).
- **Checagens de boot (fail closed):**
  1. Prefixo da chave OZAV coerente com o modo (`ozav_sk_live_` ↔ `live`, `ozav_sk_test_` ↔ `test`).
  2. `GET /v2/capabilities` confirma o ambiente da chave.
  3. Genesis hash do RPC Solana corresponde à Mainnet (`live`) ou à Devnet (`test`).
  4. Mint USDT configurado é o canônico da rede.
  5. Ref do Supabase coerente com o ambiente (guarda existente).
- **Banco:**
  - Migration nova troca os CHECKs das tabelas 020–027 por pares válidos: (`test`, `solana:devnet`) ou (`live`, `solana:mainnet`).
  - Tabela de uma linha `peragus_database_environment` grava o ambiente do banco; trigger em cada tabela de dinheiro rejeita linha com `environment` diferente.
- Rotas de simulação (`/simulate`, Pix simulado, saque sandbox e correlatas) só são registradas em `test`.
- Frontend lê o ambiente do backend e mostra avisos de teste apenas em `test`.
- Código legado do hackathon (Token-2022, settlement Anchor, demo devnet) permanece como está; já é bloqueado em produção (`app/backend/src/server.ts:377-380`).

### 4.2 Fluxo da compra (live)

**Status explícito da operação**, com transições validadas no banco (a lógica de claim/recuperação existente é mantida):

```
quoted → accepted → awaiting_pix → pix_confirmed → converted → awaiting_approval
       → approved → sending → sent → delivered_verified
terminais/exceção: expired, failed, needs_review, refund_pending, refunded
```

1. **Cotação** — `POST /v2/quotes` BRL→USDT, `target.chain=solana`, `facility_preview:true`. Limites aplicados no servidor (D2).
2. **Aceite** — grava cotação, USDT travado, `facility.terms_version` e carteira de destino. Campos financeiros imutáveis por trigger. Regras de concorrência no aceite: uma operação aberta por cliente e teto global configurável (padrão 1), via índices parciais únicos.
3. **Pix** — claim, depois `POST /v2/transfers` `fiat_payment → wallet` (carteira gerenciada do cliente, `chain=solana`) com `quote_id`, `facility_terms_accepted:true`, `facility_terms_version` e `Idempotency-Key: peragus-pix-<id>`. Recusa da trava → `failed`, sem QR. O cliente vê o BR Code e o prazo.
4. **Confirmação** — webhooks `transfer.*` (HMAC + dedup) apenas disparam `GET /v2/transfers/{id}`; o estado avança somente pelo GET. Polling por cron como fallback. Eventos `livemode` passam a ser processados no modo `live`.
5. **Fila de aprovação** — com a transfer 1 `completed`, a operação vai automaticamente para `awaiting_approval` (sem pedido de saque do cliente).
6. **Envio** — aprovação e execução pelo operador (regras em 4.4). Antes do envio: `POST /customers/{id}/destination-identifications` com `wallet_type: self_custodied` e `wallet_attested_ownership_at` = data da prova de assinatura. Depois `POST /v2/transfers` `wallet → crypto_address` (USDT, solana) com Travel Rule e `Idempotency-Key: peragus-send-<id>`. Resposta ambígua → somente leitura, nunca novo POST.
7. **Verificação on-chain** — com o `tx_hash` informado pela OZAV, o servidor consulta o RPC da rede do ambiente com commitment `finalized` e confere: mint USDT canônico, conta de destino cujo dono é a carteira verificada do cliente e valor dentro da tolerância configurada em relação ao USDT travado. Só então `delivered_verified`; divergência → `needs_review` com alerta.
8. **Conciliação e cliente** — cruza BRL pago, transfer 1, transfer 2 e transação on-chain. O cliente vê o status real e o link do Solana Explorer.

**Falhas e reembolso:** Pix fora do esperado (`needs_review`/`failed` na OZAV) → `refund_pending`. Enquanto a OZAV não
confirmar um caminho de devolução de Pix de on-ramp, o reembolso é **manual** (Pix da conta Peragus, coberto pela reserva)
e registrado no módulo existente de reembolsos (migration 028).

### 4.3 Cadastro, aceite jurídico, sessão e KYC

- **Convite/cadastro:** usam o ambiente do backend; o cadastro passa a aceitar convites `live`; o signup envia `redirect_to` explícito.
- **Aceite jurídico:**
  - Frontend: botão "Criar conta" desabilitado até Termos e Privacidade marcados. Reaproveitar telas e textos da PR #73 **sem merge da branch** (base antiga).
  - Backend: tabela append-only `customer_legal_acceptances` (usuário, cliente, documento, versão, SHA-256 do texto, data, IP, user-agent). Todas as rotas de cliente (onboarding, cotação, compra) respondem `LEGAL_ACCEPTANCE_REQUIRED` sem aceite das versões exigidas na configuração — signup direto no Supabase não contorna.
  - Troca de versão exigida → novo aceite obrigatório antes da próxima ação.
  - Política de reembolso acessível no cadastro e na tela de pagamento.
- **Sessão:** refresh token em `sessionStorage`; a sessão sobrevive ao reload e termina ao fechar o navegador.
- **KYC live:** `POST /v2/verifications` → redirecionamento para o `session_url` hospedado da OZAV; resultado por `verification.updated` confirmado por GET. Em `test`, continua a simulação. Textos de "documentos sintéticos" somente em `test`.
- **E-mails:** convite e resultado de onboarding via Resend; confirmação e recuperação via SMTP do Supabase Auth (configuração e Site URL conferidos durante a execução); worker de onboarding ligado em produção. Welcome email/pg_cron fora do caminho crítico.
- **MFA do operador:** merge da PR #104; primeiro enrollment só para contas na allowlist de operadores; perda do autenticador tratada por procedimento manual documentado (reset no painel do Supabase + registro de auditoria).

### 4.4 Operação e segurança

- **Kill switches em runtime** (tabela de controles, lidos na mesma transação da ação): `new_operations`, `usdt_sends`, `onboarding`. Alteração pelo operador com MFA renovado e auditoria. As flags de ambiente continuam como trava; ambas precisam permitir. Pausar não cancela operações em andamento.
- **Operador único (D4):**
  - Aprovar e executar exigem MFA verificado nos últimos 5 minutos, conferido no servidor pelo timestamp do método `totp` no claim `amr` do JWT.
  - Intervalo mínimo configurável entre aprovação e execução (padrão 15 min).
  - E-mail à pessoa de confiança em aprovação, execução, `needs_review`, reembolso e mudança de kill switch (outbox idempotente Resend).
  - Revisão diária da conciliação registrada pelo operador; dia sem revisão bloqueia novas operações.
  - Regra de quatro olhos (aprovador ≠ executor) implementada e desligada por configuração.
- **Alertas:** e-mail ao operador e à pessoa de confiança para operação parada além do limite por estado (ex.: `sending` > 30 min), `needs_review`, `refund_pending`, webhook com assinatura inválida e divergência de conciliação.
- **Saúde:** nova rota `/ready` (banco, pg-boss, alcance da OZAV); `/health` permanece como liveness; monitor externo de uptime nas duas.
- **Exposição:** limites D2 + uma operação aberta por cliente + teto global 1 → exposição máxima R$1.000, coberta pela reserva.
- **Higiene de produção:**
  - Ruleset da `main` (PR obrigatória, checks Backend/Frontend, sem force-push); CI também em push para `develop`.
  - Remover da Vercel de produção os segredos de Postgres/service-role da integração Supabase.
  - Remover `OZAV_QUOTE_ID`, `OZAV_TRANSFER_ID`, `OZAV_SOLANA_ADDRESS` da API de produção.
  - Chave live e segredo de webhook somente no ambiente de produção do Railway.
  - Dump semanal do banco de produção em armazenamento externo, com um teste de restauração documentado.
  - Dados de teste de 13/10 (18 settlements, 39 eventos) permanecem; tabelas legadas não usadas pelo fluxo do cliente.

### 4.5 Testes

- Unitários (TDD) para: módulo de ambiente, limites, transições de status, trava de câmbio, verificador on-chain, MFA renovado, kill switches, aceite jurídico.
- Integração com Postgres real no CI para: trigger de imutabilidade, guarda de ambiente do banco, operação única, transições permitidas, gate de aceite.
- Contrato OZAV com fixtures derivadas da spec v2, inclusive comportamentos só-live (trava, `session_url`, eventos `transfer.*`, `AMOUNT_BELOW_MINIMUM`, `FACILITY_LOCK_UNAVAILABLE`, `TRAVEL_RULE_REQUIRED`).
- Smoke ponta a ponta em staging (script): convite → cadastro → aceite → KYC simulado → carteira devnet → cotação → Pix simulado → aprovação → envio → conciliação. Em `test`, a trava de câmbio fica desligada; se o `tx_hash` do sandbox não existir na devnet, a operação fica marcada como simulada e nunca `delivered_verified`.

## 5. Liberação em etapas

0. **Evidências OZAV live (sem mover dinheiro):** `GET /v2/capabilities` com a chave live registrando on-ramp BRL→USDT/Solana, custódia, envio externo, Travel Rule, facility de trava, `session_url` de KYC e webhooks. Respostas escritas da OZAV para as pendências da seção 6.
1. **Staging verde:** CI e smoke completos.
2. **Produção com todos os kill switches desligados:** checagens de boot e `/ready` verdes.
3. **Transação interna (R$1.000)** com a pessoa de confiança (D6) e pacote de evidências: IDs OZAV, `tx_hash`, Explorer, conciliação, auditoria, e-mails, capturas de tela.
4. **Revisão de Go/No-Go** registrada pelo responsável; só então convites a clientes externos.

## 6. Pendências externas (OZAV)

| Pendência | Impacto se negativa |
|---|---|
| Facility de trava de câmbio contratado e custo | Sem trava não há Pix (D3); exige rever D3 |
| `session_url` de KYC habilitado na conta live | KYC live bloqueado |
| Caminho de devolução de Pix de on-ramp | Reembolso segue manual pela reserva |
| Criação da conta de token (ATA) do destinatário | Exigir ATA existente na prova de carteira |
| Valor entregue: exato ou com taxa de rede descontada | Ajustar tolerância da verificação on-chain |
| Redução do piso para R$50 | Apenas configuração (D2) |

## 7. Critérios de Go/No-Go para clientes externos

GO somente com evidência de todos:

1. Capabilities live registradas e respostas da OZAV arquivadas.
2. Conta criada por convite com e-mail confirmado.
3. Aceite jurídico gravado no backend com versão e hash.
4. Login, sessão e MFA do operador funcionando em produção.
5. KYC aprovado pela sessão hospedada da OZAV.
6. Carteira verificada com prova de assinatura de Mainnet.
7. Cotação com câmbio travado, aceita.
8. Pix real reconhecido pelo GET da OZAV.
9. Aprovação e execução com MFA renovado, intervalo respeitado e alerta recebido pela pessoa de confiança.
10. USDT enviado uma única vez, sem POST duplicado nos logs.
11. Entrega `finalized` na Mainnet com mint, destinatário e valor conferidos.
12. Conciliação BRL ↔ transfer 1 ↔ transfer 2 ↔ on-chain fechada.
13. Cliente vê o status real e o link do Explorer.
14. Kill switches testados (pausar e retomar sem perda de operação).
15. Nenhum recurso de staging usado pela produção (checagens de boot e logs).
16. Backup externo com restauração testada; `main` protegida.

Qualquer bloqueador financeiro ou de segurança em aberto = **NO-GO**.

## 8. Matriz de bloqueadores P0

| Item | Estado | Pendência | Critério de aceite |
|---|---|---|---|
| Capacidade live OZAV | F → evidência | `GET /capabilities` + respostas da seção 6 | Registro arquivado |
| Caminho live no código e banco | E | 4.1 | Boot recusa configuração cruzada; testes de integração |
| Limites R$1.000 e concorrência | E/D | 4.2 passos 1–2 | Testes de integração dos índices e limites |
| Trava de câmbio | E | 4.2 passos 1–3 | Fixture + transação interna |
| Pix real (webhook + GET) | D/E | 4.2 passo 4 | Fixture + transação interna |
| Verificação on-chain | E | 4.2 passo 7 | Testes + transação interna |
| Aceite jurídico no backend | E | 4.3 | Teste de integração do gate |
| KYC live | E | 4.3 | Transação interna |
| Prova de carteira Mainnet | D | 4.1 / 4.3 | Teste + transação interna |
| Controles do operador e kill switches | D | 4.4 | Testes + exercício na produção |
| Sessão persistente | C | 4.3 | Teste de reload |
| Higiene de produção | E | 4.4 | Checklist verificado |

## 9. Fora do escopo

KYB/PJ e modelo com comerciantes (fase 2); POS e adquirentes; Paraguai e BRL→PYG; programa Anchor na Mainnet;
multi-chain; app mobile; cashback/referral/fidelidade; redesign visual sem bloqueio funcional; welcome email com pg_cron
em produção; redesenho completo da state machine (estratégia C); remoção do código legado do hackathon.

## 10. Riscos aceitos

- Minutas jurídicas não revisadas em uso com clientes externos (D7).
- Operador único, sem quatro olhos ativo (D4), mitigado por controles compensatórios.
- Trava de câmbio, Pix real e KYC hospedado validados pela primeira vez em produção, na transação interna, por não existirem no sandbox da OZAV.
