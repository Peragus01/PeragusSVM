# Checklist de configuração — staging e produção

Documento para o responsável (operador único). Lista toda variável e configuração que o código exige hoje,
por ambiente e por plataforma. **Nunca** registre valores reais de segredos aqui, em chat ou em logs: os
valores abaixo são formatos ou valores públicos. Fonte da verdade: `app/backend/src/config/env.ts`,
`app/backend/src/config/money-environment.ts`, `app/backend/src/notifications/*.ts`,
`app/frontend/src/lib/peragus/config.ts` e os arquivos `.env.example`.

Este arquivo é verificado por um teste (`app/backend/test/configuration-checklist.test.ts`): toda chave do
schema de `env.ts` precisa aparecer aqui. Ao adicionar uma variável ao backend, documente-a neste arquivo.

## 0. Regras que valem para os dois ambientes

- `production → live → solana:mainnet`; `staging → test → solana:devnet`. Nenhuma outra combinação sobe: o
  processo recusa iniciar (`ENVIRONMENT_CONFIGURATION_INVALID`, `MONEY_PATH_NOT_LIVE_READY`, `MONEY_ENVIRONMENT_INVALID`).
- Nunca use a chave live (`ozav_sk_live_`) em staging nem a chave de teste (`ozav_sk_test_`) em produção.
- `PERAGUS_DEPLOYMENT_ENV` precisa ser definida **explicitamente** em todo serviço e em todo job que roda
  `npm run db:migrate` (o script recusa rodar sem ela). O padrão do schema é `staging`; confiar nele em
  produção é um erro.
- Segredos só em variáveis seladas/secretas da plataforma. Toda variável `VITE_*` vai para o navegador: só valores públicos.
- Cada serviço Railway (API e workers) precisa de `DATABASE_URL` do projeto Supabase do **próprio ambiente**:
  produção `athwkklyvnaetotmancy`, staging `lybdkqkbwlfwvmmvstzi` (guarda de boot compara host, usuário e `SUPABASE_URL`).
- Valor do `LEGAL_REQUIRED_DOCUMENTS` (igual ao conteúdo de `docs/operations/legal-required-documents.json`; teste de
  hash em `legal-documents-hash.test.ts`), em uma linha:

```json
{"terms":{"version":"draft-0.9-2026-11-03","sha256":"878835648a716afec9ed2834e9c04b0d312d2c562128c93f24ec938063e4a451"},"privacy":{"version":"draft-0.9-2026-11-03","sha256":"6539cbeb8f1ca83f29148f5913624fcb0a72641e7bc5a8a2901f1f230cab3ed3"},"refund":{"version":"2026-11-02","sha256":"73d84a9678e3b2ef98b67be11c94a78a6b14a6ac47fe931fbce774aa3478ca57"}}
```

  Trocar uma versão ou hash obriga todo cliente a aceitar de novo (`LEGAL_ACCEPTANCE_REQUIRED`).

Legenda das colunas: **Variável/ajuste**, **Valor esperado** (formato, nunca segredo real), **Por quê**.

---

## 1. Produção

### 1.1 Railway — API de produção

| Variável/ajuste | Valor esperado | Por quê |
|---|---|---|
| `PERAGUS_DEPLOYMENT_ENV` | `production` | Deriva o modo live/Mainnet; sem ela o padrão seria `staging`. Também exigida por `db:migrate`. |
| `NODE_ENV` | `production` | Modo de execução do Node. |
| `HOST` / `PORT` | `0.0.0.0` / porta injetada pela Railway | A API precisa escutar fora do loopback. |
| `LOG_LEVEL` | `info` | Logs estruturados sem dados pessoais. |
| `DATABASE_URL` | URL do Postgres do projeto Supabase de produção (`athwkklyvnaetotmancy`), conexão direta ou pooler `sa-east-1` na porta 5432, banco `postgres` | Guarda de boot recusa host/usuário/projeto de outro ambiente. Segredo. |
| `DATABASE_SSL` | `true` | Conexão cifrada com o Supabase. |
| `SUPABASE_URL` | `https://athwkklyvnaetotmancy.supabase.co` | Autenticação dos usuários; precisa ser exatamente o projeto de produção. |
| `SUPABASE_PUBLISHABLE_KEY` | chave publicável (anon) do projeto de produção | Validação de token no Auth. Nunca a service-role. |
| `OZAV_API_KEY` | `ozav_sk_live_...` (segredo; só neste ambiente) | Prefixo precisa casar com o modo live. `ozav_sk_test_` em produção impede o boot. |
| `CUSTOMER_WEBHOOKS_ENABLED` | `true` | Recebe os eventos `transfer.*` e `verification.updated` da OZAV. |
| `CUSTOMER_WEBHOOK_SECRET` | `ozav_whsec_...` (segredo do endpoint de **produção**) | HMAC do webhook. Obrigatório com o flag acima. |
| `SOLANA_RPC_URL` | URL de RPC da **Mainnet** (nunca contém "devnet"); precisa devolver `blockTime` nas transações | Verificação on-chain `finalized`; sem `blockTime` toda entrega vira `needs_review` `TX_PREDATES_SEND`. O genesis hash da Mainnet é conferido no boot. |
| `SOLANA_USDT_MINT` | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` (ou ausente) | Mint canônico da Mainnet; qualquer outro valor impede o boot. |
| `SOLANA_PROGRAM_ID` | não definir (padrão legado) | Código legado do hackathon; fora do caminho live. |
| `LEGAL_REQUIRED_DOCUMENTS` | JSON da seção 0 | Gate de aceite jurídico em todas as rotas de cliente. |
| `TRUST_PROXY_HOPS` | `1` | Railway tem 1 proxy; garante o IP real na evidência do aceite jurídico e nos limites de taxa. |
| `API_RATE_LIMITS_ENABLED` | `true` | Limites de leitura/escrita por usuário (migration 032). |
| `CUSTOMER_DATA_ENCRYPTION_KEY` | chave de 32 bytes em base64 (segredo) | Cifra dos dados de cadastro. |
| `CUSTOMER_DATA_ENCRYPTION_KEY_ID` | `v1` (ou novo id de rotação, `[A-Za-z0-9_-]{1,32}`) | Identifica a chave usada. |
| `WITHDRAWAL_OPERATOR_USER_IDS` | UUID(s) do Supabase Auth do operador (até 5, separados por vírgula) | Lista de operadores autorizados. **Nunca** a conta de cliente (separação de contas). |
| `OPERATOR_MFA_MAX_AGE_SECONDS` | `300` (30 a 300) | TOTP verificado há no máximo 5 min para ações que movem dinheiro. |
| `OPERATOR_EXECUTION_MIN_DELAY_SECONDS` | `900` (0 a 86400) | Intervalo mínimo entre aprovar e executar o envio (controle compensatório do operador único). |
| `OPERATOR_FOUR_EYES_ENABLED` | `false` | Quatro olhos pronto, mas desligado (operador único). `true` exigiria um segundo operador. |
| `USDT_DELIVERY_TOLERANCE_UNITS` | `100000` (unidades de 6 casas = 0,10 USDT) | A OZAV desconta a taxa de rede do USDT enviado; a entrega on-chain pode ficar abaixo do travado até essa tolerância. |
| `PURCHASE_MIN_BRL` | `1000.00` | Piso por operação (D2; piso da OZAV R$ 1.000). |
| `PURCHASE_MAX_BRL` | `1000.00` | Teto por operação; exposição máxima R$ 1.000. |
| `PURCHASE_MAX_OPEN_GLOBAL` | `1` | Uma operação aberta no total. |
| `MANUAL_REFUNDS_ENABLED` | `true` | Sem isto o operador não consegue decidir/registrar reembolso (compromisso de 24 h da política). |
| `CUSTOMER_PURCHASE_INTENTS_ENABLED` | `true` | Aceite de cotação/compra. Os kill switches de runtime controlam a ordem de abertura. |
| `CUSTOMER_QUOTES_ENABLED` | `true` | Cotações com trava de câmbio. |
| `CUSTOMER_SANDBOX_PIX_ENABLED` | `true` | Nome legado: é o caminho do Pix **live** (seguro em live). Só a simulação é recusada. |
| `CUSTOMER_WITHDRAWAL_REQUESTS_ENABLED` | `true` | Fila de aprovação do envio. |
| `WITHDRAWAL_OPERATOR_APPROVALS_ENABLED` | `true` | Aprovação pelo operador. |
| `SANDBOX_WITHDRAWAL_EXECUTION_ENABLED` | `true` | Nome legado: execução do envio live de USDT (seguro em live desde a Task 10). |
| `SANDBOX_WITHDRAWAL_RECOVERY_ENABLED` | `true` | Leitura/reconciliação do envio (somente GET). |
| `CUSTOMER_ONBOARDING_ENABLED` / `CUSTOMER_TERMS_ENABLED` / `CUSTOMER_SUBMISSION_ENABLED` | `true` | Cadastro PF, aceite e envio dos dados. |
| `CUSTOMER_VERIFICATIONS_ENABLED` | `true` | KYC hospedado da OZAV (`session_url`). |
| `CUSTOMER_SCREENINGS_ENABLED` | `true` | Triagem cadastral. |
| `CUSTOMER_ONBOARDING_STATUS_ENABLED` | `true` | Status de onboarding visível ao cliente. |
| `CUSTOMER_WALLET_LINKING_ENABLED` | `true` | Prova de carteira por assinatura (Mainnet). |
| `CUSTOMER_DOCUMENTS_ENABLED` / `CUSTOMER_DOCUMENT_UPLOAD_ORIGINS` | `false` / vazio | Upload de documentos é implementação apenas para staging sintético; ligar exige origens `storage.ozav.io`. |
| `PILOT_INVITES_ENABLED` | `true` | Cadastro só por convite. |
| `INVITE_EMAIL_OUTBOX_ENABLED` | `true` | Envio dos convites por e-mail (outbox idempotente). Exige as quatro variáveis seguintes, `DATABASE_URL`, `SUPABASE_URL` de produção e flags financeiras legadas desligadas. |
| `INVITE_EMAIL_ENCRYPTION_KEY` | base64 de exatamente 32 bytes (segredo) | Cifra do e-mail do convite. |
| `INVITE_EMAIL_ENCRYPTION_KEY_ID` | `[A-Za-z0-9_-]{1,32}` | Id da chave acima. |
| `INVITE_EMAIL_FROM` | `convites@peragus.com.br` (qualquer remetente `@peragus.com.br`) | O código exige domínio `@peragus.com.br`. |
| `INVITE_EMAIL_WEBHOOK_SECRET` | `whsec_...` (segredo do webhook de e-mail do Resend) | Entrega/rejeição de e-mails de convite. |
| `PILOT_INVITE_EMAIL_HASH_KEY` | 64 caracteres hex (segredo); estável | HMAC do e-mail vinculado ao convite; trocar invalida convites pendentes. |
| `RESEND_API_KEY` | `re_...` (segredo) | Envio de convites e alertas via Resend. |
| `ONBOARDING_EMAILS_ENABLED` | `false` no deploy inicial; vira `true` só depois do boot conferido (passo 4 da liberação em `internal-transaction-runbook.md`), com a pessoa de confiança na allowlist (ver seção 4) | E-mail de resultado de onboarding; em produção exige `RESEND_FROM`, `ONBOARDING_EMAIL_ACCOUNT_URL` https e allowlist. |
| `RESEND_FROM` | remetente `@peragus.com.br` | Remetente do e-mail de onboarding (só se o flag acima estiver ligado). |
| `ONBOARDING_EMAIL_ACCOUNT_URL` | `https://www.peragus.com.br/app/minha-conta` (https, sem query/hash) | Link no e-mail de onboarding. |
| `ONBOARDING_EMAIL_TEST_USER_IDS` | até 5 UUIDs de usuários consentidos | Allowlist do e-mail de onboarding. |
| `ONBOARDING_EMAIL_DEPLOYMENT_ENV` | não definir na API (o código a deriva de `PERAGUS_DEPLOYMENT_ENV`) | Evita divergência de ambiente. Definir só no serviço dedicado de e-mails, igual a `production`. |
| `RAILWAY_ENVIRONMENT_NAME` | `production` (injetada pela Railway) | O boot recusa divergência com `PERAGUS_DEPLOYMENT_ENV`. Não sobrescrever. |
| Domínio / healthcheck | `/health` (liveness) e `/ready` (banco, pg-boss, OZAV) | Monitor externo de uptime nas duas rotas (ver `operator-runbook.md`). |
| Remover | `OZAV_QUOTE_ID`, `OZAV_TRANSFER_ID`, `OZAV_SOLANA_ADDRESS` | Sobras de testes; não são lidas pelo código atual. |

### 1.2 Railway — workers de produção (`npm run start:worker`; e-mails de onboarding/convites, se serviços separados)

| Variável/ajuste | Valor esperado | Por quê |
|---|---|---|
| `PERAGUS_DEPLOYMENT_ENV` | `production` | Idem API; também em qualquer serviço que rode `db:migrate`. |
| `NODE_ENV` / `LOG_LEVEL` | `production` / `info` | Padrão. |
| `DATABASE_URL` / `DATABASE_SSL` | mesmo projeto de produção / `true` | Fila pg-boss e reconciliação no mesmo banco. |
| `SUPABASE_URL` | `https://athwkklyvnaetotmancy.supabase.co` | Guarda de ambiente do worker de e-mails. |
| `OZAV_API_KEY` | `ozav_sk_live_...` | Reconciliação por GET e checagem de boot (`/v2/capabilities`). |
| `SOLANA_RPC_URL` | RPC da Mainnet com `blockTime` | Verificação on-chain da entrega e checagem de genesis hash. |
| `SOLANA_USDT_MINT` | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | Mint canônico. |
| `USDT_DELIVERY_TOLERANCE_UNITS` | `100000` | Mesma tolerância da API. |
| `CUSTOMER_RECONCILIATION_ENABLED` | `true` | Reconciliação das operações (Pix, transfer, envio, on-chain). |
| `OZAV_RECONCILIATION_INTERVAL_SECONDS` | `30` (1 a 3600) | Intervalo do polling de fallback. |
| `OZAV_RECONCILIATION_MAX_ATTEMPTS` | `120` (1 a 10000) | Limite de tentativas antes de alertar. |
| `JOB_POLL_INTERVAL_SECONDS` / `JOB_CONCURRENCY` | `2` / `3` | Parâmetros do pg-boss. |
| `OPERATOR_NOTIFICATIONS_ENABLED` | `true` | O worker só envia alertas e roda o scanner de operações paradas com este flag. A API (`server.ts`) não lê estas variáveis: não precisam estar na API. Se forem definidas lá, a validação compartilhada de `env.ts` se aplica igual (e-mails distintos, remetente `@peragus.com.br`, `DATABASE_URL`), então mantenha os mesmos valores nos dois ou omita-os na API. |
| `OPERATOR_ALERT_EMAIL` | e-mail do operador | Destinatário dos alertas; validado, nunca logado. |
| `TRUSTED_ALERT_EMAIL` | e-mail da pessoa de confiança — **diferente** do anterior | Controle compensatório do operador único; o boot recusa e-mails iguais. |
| `OPERATOR_NOTIFICATIONS_FROM` | `alertas@peragus.com.br` (domínio `@peragus.com.br`) | Remetente dos alertas. |
| `RESEND_API_KEY` | `re_...` (segredo) | Entrega dos alertas. |
| `INVITE_EMAIL_OUTBOX_ENABLED` e variáveis `INVITE_EMAIL_*` | iguais às da API, se o worker de convites rodar no mesmo serviço | Mesmas exigências da seção 1.1. |
| `WORKER_SMOKE_TEST_ENABLED` | `false` | Diagnóstico de staging; não ligar em produção. |
| Flags financeiras legadas | `false` (seção 1.6) | O boot recusa. |

### 1.3 Vercel — frontend de produção

| Variável/ajuste | Valor esperado | Por quê |
|---|---|---|
| `VITE_PERAGUS_MONEY_MODE` | `live` | Sem isto o front trata o ambiente como teste (avisos de "ambiente de testes", RPC devnet). Precisa casar com o backend. |
| `VITE_API_BASE_URL` | `/api` (padrão) | Rota de proxy para a API. |
| `PERAGUS_BACKEND_URL` | origem HTTPS da API de **produção** (somente servidor; sem prefixo `VITE_`) | Destino do proxy `/api`. |
| `VITE_SUPABASE_URL` | `https://athwkklyvnaetotmancy.supabase.co` | Login e recuperação de senha. |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | chave publicável do projeto de produção | Pública; nunca service-role. |
| `VITE_SOLANA_RPC_URL` | RPC pública da Mainnet (ou ausente: o padrão em live nunca é devnet) | Leitura de saldo/explorer no navegador. |
| `VITE_DEMO_CORRIDOR_ID` / `VITE_DEMO_RECIPIENT_WALLET` / `VITE_DEMO_PAYOUT_DESTINATION_ID` | ausentes | Legado do demo do hackathon. |
| Remover | `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, `POSTGRES_URL_NON_POOLING`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_HOST`, `POSTGRES_DATABASE` (qualquer `POSTGRES_*`), `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_JWT_SECRET` | Segredos injetados pela integração Supabase; o front não os usa. Confirmar que o build continua verde após remover e desinstalar/ajustar a integração para não reinjetar. |
| Branch de produção | `main` | Deploy de produção só a partir da `main`. |

### 1.4 Supabase — projeto de produção (`athwkklyvnaetotmancy`)

| Variável/ajuste | Valor esperado | Por quê |
|---|---|---|
| Auth › SMTP personalizado (Resend) | Host `smtp.resend.com`, remetente `@peragus.com.br`, domínio verificado no Resend | Confirmação de e-mail e recuperação de senha. O SMTP padrão do Supabase tem limite baixo e não serve para produção. |
| Auth › URL Configuration › Site URL | `https://www.peragus.com.br` | Base dos links dos e-mails. |
| Auth › Redirect URLs | somente `https://www.peragus.com.br/**` (sem `localhost`, sem preview) | O cadastro envia `redirect_to` explícito. |
| Auth › Password protection | **Leaked password protection ligada** | Bloqueia senhas vazadas. Evidência: captura do painel. |
| Auth › Confirmação de e-mail | ligada | Go/No-Go 2 (conta com e-mail confirmado). |
| Auth › MFA (TOTP) | habilitado | Operador exige AAL2 e TOTP recente. |
| Auth › Cadastro público | conforme política de convites (cadastro só com convite é imposto pelo backend) | Signup direto não contorna o gate jurídico, mas reduza a superfície. |
| Banco › migrations | `npm run db:migrate` aplicado com `PERAGUS_DEPLOYMENT_ENV=production` (migrations 001–055) | A linha de ambiente do banco (`peragus_database_environment`) é gravada pelo migrate e é checada pelos triggers. |
| Banco › backup | dump semanal externo e teste de restauração | Ver `backup-and-restore.md`. |
| Reset de fator MFA | procedimento manual | Ver `operator-mfa-reset.md`. |
| `supabase/migrations` (welcome email, pg_cron) | **não aplicar** em produção | Fora do caminho crítico (spec seção 9). |

### 1.5 Painel da OZAV — conta live

| Variável/ajuste | Valor esperado | Por quê |
|---|---|---|
| Chave de API | `ozav_sk_live_...` criada para a Peragus; copiar só para o Railway de produção | Prefixo precisa casar com o modo. |
| Endpoint de webhook | `https://<origem-da-API-de-producao>/webhooks/customer-updates`, eventos `transfer.updated`, `transfer.completed`, `transfer.failed`, `verification.updated` (e `requirement.due`, se oferecido) | Rota implementada em `routes/customer-webhooks.ts`; o segredo `ozav_whsec_...` gerado vai para `CUSTOMER_WEBHOOK_SECRET`. Eventos `livemode:false` são ignorados na produção. |
| Capabilities | `GET /v2/capabilities` com a chave live: on-ramp BRL→USDT/Solana, custódia gerenciada, envio externo, Travel Rule, facility de trava de câmbio, `session_url` de KYC | Go/No-Go 1; arquivar a resposta. |
| Facility de trava de câmbio | contratado e ativo | Sem trava aceita não existe Pix (D3). |
| `session_url` de KYC | habilitado na conta live | KYC live. O host da sessão precisa estar na lista aceita (`ozav.io`/`*.ozav.io`). |
| Reembolso | solicitação manual ao suporte/canal manual da OZAV | Política de reembolso: a OZAV executa a devolução a pedido do operador (ver `operator-runbook.md`). |
| Conta de token (ATA) do destinatário | confirmar se a OZAV cria a ATA | Pendência em aberto: sem isso o envio é bloqueado por `DESTINATION_TOKEN_ACCOUNT_MISSING`. |

### 1.6 Produção — flags que devem permanecer desligadas (ou ausentes) em live

O backend recusa o boot (`MONEY_PATH_NOT_LIVE_READY`) quando uma das três primeiras está `true` em produção; as demais
são recusadas pelas guardas do `server.ts`/convites ou são legado do hackathon.

| Variável | Valor | Por quê |
|---|---|---|
| `CUSTOMER_SANDBOX_PIX_SIMULATION_ENABLED` | `false` | Simulação de Pix não existe em live (MONEY_PATH_NOT_LIVE_READY). |
| `CUSTOMER_VERIFICATION_SIMULATION_ENABLED` | `false` | Simulação de KYC não existe em live (MONEY_PATH_NOT_LIVE_READY). |
| `SANDBOX_WITHDRAWAL_CLOSURE_ENABLED` | `false` | Encerramento sandbox do envio; em live o slot é liberado automaticamente (MONEY_PATH_NOT_LIVE_READY). |
| `OZAV_ONRAMP_WRITES_ENABLED` / `OZAV_OFFRAMP_WRITES_ENABLED` | `false` | Caminho legado do hackathon; a API recusa subir com eles. |
| `SOLANA_COSIGNING_ENABLED` / `SOLANA_CONTINGENCY_RESERVE_ENABLED` | `false` | Idem (programa Anchor/Token-2022 legado). |
| `PERAGUS_SANDBOX_DEMO_ENABLED` | `false` | Demo devnet; bloqueado em produção. |
| `SETTLEMENT_DRAFTS_ENABLED` / `OZAV_SANDBOX_CUSTOMERS_ENABLED` | `false` | Fixtures de sandbox. |
| `WORKER_SMOKE_TEST_ENABLED` | `false` | Diagnóstico de staging. |
| `SOLANA_SOURCE_MINT` / `SOLANA_DESTINATION_MINT` | ausentes | Só para o legado de cosigning. |
| `SOLANA_ATTESTATION_KEYPAIR_PATH` / `SOLANA_ATTESTATION_KEYPAIR_BASE64` | ausentes | Chaves do legado; sem signer na Peragus (nenhuma hot wallet). |
| `SOLANA_LIQUIDITY_KEYPAIR_PATH` / `SOLANA_LIQUIDITY_KEYPAIR_BASE64` | ausentes | Idem. |
| `SOLANA_FEE_PAYER_KEYPAIR_PATH` / `SOLANA_FEE_PAYER_KEYPAIR_BASE64` | ausentes | Idem. |
| `SOLANA_CONTINGENCY_FALLBACK_SECONDS` | ausente (padrão `300`) | Legado. |
| `OZAV_CUSTOMER_ID` / `OZAV_WALLET_ID` | ausentes | Legado do demo; o cliente é direto da OZAV (KYC próprio) e a carteira é por cliente. |
| `OZAV_SOURCE_DECIMALS` / `OZAV_SPREAD_BPS` / `OZAV_MIN_SOURCE_AMOUNT_BRL` | ausentes (padrões `6` / `0` / `400`) | Parâmetros do legado; os limites reais são `PURCHASE_*`. |
| `CUSTOMER_DOCUMENTS_ENABLED` | `false` | Ver 1.1. |

---

## 2. Staging

Staging é o ambiente `test`/devnet. Mesmo código, outra chave, outro banco, outro RPC. Nada daqui usa dinheiro real.

### 2.1 Railway — API de staging

| Variável/ajuste | Valor esperado | Por quê |
|---|---|---|
| `PERAGUS_DEPLOYMENT_ENV` | `staging` (explícito) | Modo `test`/devnet. Também em qualquer serviço/job que rode `db:migrate`. |
| `NODE_ENV` / `HOST` / `PORT` / `LOG_LEVEL` | `production` / `0.0.0.0` / porta injetada / `info` | Execução hospedada. |
| `DATABASE_URL` / `DATABASE_SSL` | Postgres do projeto Supabase de staging (`lybdkqkbwlfwvmmvstzi`) / `true` | Guarda de boot por projeto. Segredo. |
| `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` | `https://lybdkqkbwlfwvmmvstzi.supabase.co` / chave publicável de staging | Autenticação. |
| `OZAV_API_KEY` | `ozav_sk_test_...` | Prefixo `test` obrigatório em staging; a chave live nunca entra aqui. |
| `CUSTOMER_WEBHOOKS_ENABLED` / `CUSTOMER_WEBHOOK_SECRET` | `true` / `ozav_whsec_...` do endpoint de staging | Webhook de teste; eventos `livemode:true` são ignorados. |
| `SOLANA_RPC_URL` | RPC da **Devnet** (ex.: `https://api.devnet.solana.com`) | Genesis hash da Devnet conferido no boot. |
| `SOLANA_USDT_MINT` | mint de teste da devnet (base58, 32 a 44 caracteres) | **Obrigatório em qualquer processo de staging** (`resolveMoneyEnvironment` recusa com `MONEY_ENVIRONMENT_INVALID` sem ele; o schema o exige ainda por validação quando cotação/compra/Pix/envio estão ligados). Só em produção ele é opcional (o mint canônico é fixo). |
| Conta de token USDT devnet | uma conta de token (ATA) do mint de teste para **cada carteira de teste** de cliente | O envio recusa `DESTINATION_TOKEN_ACCOUNT_MISSING` se a carteira de destino não tiver ATA do mint configurado. Criar a ATA antes do smoke. |
| `LEGAL_REQUIRED_DOCUMENTS` | JSON da seção 0 | Gate jurídico idêntico à produção. |
| `TRUST_PROXY_HOPS` | `1` | Railway. |
| `API_RATE_LIMITS_ENABLED` | `true` | Mesmo comportamento da produção. |
| `CUSTOMER_DATA_ENCRYPTION_KEY` / `CUSTOMER_DATA_ENCRYPTION_KEY_ID` | chave própria de staging (32 bytes base64) / `v1` | Nunca reutilizar a de produção. |
| `WITHDRAWAL_OPERATOR_USER_IDS` | UUID(s) do operador no Auth de **staging** | Allowlist. |
| `OPERATOR_MFA_MAX_AGE_SECONDS` / `OPERATOR_EXECUTION_MIN_DELAY_SECONDS` / `OPERATOR_FOUR_EYES_ENABLED` | `300` / `900` (pode reduzir para testes) / `false` | Controles do operador. |
| `USDT_DELIVERY_TOLERANCE_UNITS` | `100000` | Tolerância de taxa de rede. |
| `PURCHASE_MIN_BRL` / `PURCHASE_MAX_BRL` / `PURCHASE_MAX_OPEN_GLOBAL` | `1000.00` / `1000.00` / `1` (ou valores menores de teste) | Mesmos limites. |
| `MANUAL_REFUNDS_ENABLED` | `true` | Exercitar o fluxo de reembolso. |
| Flags do cliente (`CUSTOMER_*_ENABLED`, `PILOT_INVITES_ENABLED`, `WITHDRAWAL_OPERATOR_APPROVALS_ENABLED`, `SANDBOX_WITHDRAWAL_EXECUTION_ENABLED`, `SANDBOX_WITHDRAWAL_RECOVERY_ENABLED`) | `true`, como na produção | Smoke ponta a ponta. |
| `CUSTOMER_SANDBOX_PIX_SIMULATION_ENABLED` / `CUSTOMER_VERIFICATION_SIMULATION_ENABLED` | `true` somente em staging, se o smoke precisar | Simulações só existem em `test`. |
| `INVITE_EMAIL_OUTBOX_ENABLED` e `INVITE_EMAIL_*`, `PILOT_INVITE_EMAIL_HASH_KEY` | como na produção, com `SUPABASE_URL` de staging | Convites por e-mail. |
| `RESEND_API_KEY` | `re_...` | E-mails; os assuntos levam `[TESTES]`. |
| `ONBOARDING_EMAILS_ENABLED`, `RESEND_FROM`, `ONBOARDING_EMAIL_ACCOUNT_URL`, `ONBOARDING_EMAIL_TEST_USER_IDS`, `ONBOARDING_EMAIL_DEPLOYMENT_ENV` | opcional; `staging` no serviço dedicado | Só com usuários consentidos. |
| `RAILWAY_ENVIRONMENT_NAME` | `staging` (injetada) | Guarda de divergência. |

### 2.2 Railway — workers de staging

| Variável/ajuste | Valor esperado | Por quê |
|---|---|---|
| `PERAGUS_DEPLOYMENT_ENV` | `staging` | Idem API. |
| `DATABASE_URL` / `DATABASE_SSL` / `SUPABASE_URL` | staging / `true` / `https://lybdkqkbwlfwvmmvstzi.supabase.co` | Guarda de ambiente. |
| `OZAV_API_KEY` | `ozav_sk_test_...` | Reconciliação em test. |
| `SOLANA_RPC_URL` / `SOLANA_USDT_MINT` | Devnet / mint de teste (obrigatório no worker de staging também) | Verificação on-chain; sandbox cujo `tx_hash` não existe na devnet fica simulado, nunca `delivered_verified`. |
| `USDT_DELIVERY_TOLERANCE_UNITS` | `100000` | Idem. |
| `CUSTOMER_RECONCILIATION_ENABLED` | `true` | Reconciliação. |
| `OZAV_RECONCILIATION_INTERVAL_SECONDS` / `OZAV_RECONCILIATION_MAX_ATTEMPTS` | `30` / `120` | Polling. |
| `JOB_POLL_INTERVAL_SECONDS` / `JOB_CONCURRENCY` | `2` / `3` | pg-boss. |
| `OPERATOR_NOTIFICATIONS_ENABLED` | `true` (recomendado, para exercitar os alertas) | Scanner e outbox. |
| `OPERATOR_ALERT_EMAIL` / `TRUSTED_ALERT_EMAIL` / `OPERATOR_NOTIFICATIONS_FROM` | e-mails distintos / remetente `@peragus.com.br` | Mesmas regras do boot. Atenção: a primeira ativação pode enviar um lote de alertas históricos. |
| `RESEND_API_KEY` | `re_...` | Entrega. |
| `WORKER_SMOKE_TEST_ENABLED` | `true` somente durante o diagnóstico descrito em `staging-worker-smoke-test.md`; depois `false` | Diagnóstico do worker. |

### 2.3 Vercel — frontend de staging (preview/branch `develop`)

| Variável/ajuste | Valor esperado | Por quê |
|---|---|---|
| `VITE_PERAGUS_MONEY_MODE` | `test` (padrão) | Mostra avisos de ambiente de testes. |
| `VITE_API_BASE_URL` | `/api` | Proxy. |
| `PERAGUS_BACKEND_URL` | origem HTTPS da API de **staging** | Destino do proxy. |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY` | projeto de staging | Login. |
| `VITE_SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Devnet. |
| Variáveis `POSTGRES_*` / service-role | ausentes | Mesma higiene da produção. |

### 2.4 Supabase — projeto de staging (`lybdkqkbwlfwvmmvstzi`)

| Variável/ajuste | Valor esperado | Por quê |
|---|---|---|
| Auth › SMTP | Resend (`smtp.resend.com`), remetente `@peragus.com.br` | Confirmação/recuperação. |
| Auth › Site URL / Redirect URLs | origem pública do frontend de staging (domínio atual da Vercel de staging) | Links dos e-mails. A origem do app de staging e o domínio da prova de carteira (`peragussvm-staging.up.railway.app`) são constantes em `app/backend/src/config/money-environment.ts` (`appOrigin`, `walletProofDomain`); a Site URL e o domínio real de staging precisam coincidir com elas, senão convites e provas de carteira falham. |
| Auth › Leaked password protection | ligada | Paridade com produção. |
| Auth › MFA (TOTP) | habilitado | Operador exige AAL2. |
| Banco › migrations | `db:migrate` com `PERAGUS_DEPLOYMENT_ENV=staging` | Linha de ambiente do banco. |

### 2.5 Painel da OZAV — conta de teste

| Variável/ajuste | Valor esperado | Por quê |
|---|---|---|
| Chave de API | `ozav_sk_test_...` | Staging. |
| Endpoint de webhook | `https://peragussvm-staging.up.railway.app/webhooks/customer-updates` (ou a origem atual da API de staging) | Segredo `ozav_whsec_...` de teste em `CUSTOMER_WEBHOOK_SECRET` de staging. |
| Limitações do sandbox | sem trava de câmbio e sem `session_url` | O smoke de staging não prova trava, KYC hospedado nem Pix real; isso é provado na transação interna. |

### 2.6 Staging — flags que ficam desligadas

Mesma lista da seção 1.6 para as variáveis legadas (`OZAV_ONRAMP_WRITES_ENABLED`, `OZAV_OFFRAMP_WRITES_ENABLED`,
`SOLANA_COSIGNING_ENABLED`, `SOLANA_CONTINGENCY_RESERVE_ENABLED`, `PERAGUS_SANDBOX_DEMO_ENABLED`,
`SETTLEMENT_DRAFTS_ENABLED`, `OZAV_SANDBOX_CUSTOMERS_ENABLED`, `CUSTOMER_DOCUMENTS_ENABLED`). Em staging
`CUSTOMER_SANDBOX_PIX_SIMULATION_ENABLED`, `CUSTOMER_VERIFICATION_SIMULATION_ENABLED` e
`SANDBOX_WITHDRAWAL_CLOSURE_ENABLED` podem ser `true` para o smoke; nunca em produção.

---

## 3. GitHub

| Ajuste | Valor esperado | Por quê |
|---|---|---|
| Workflow `CI` (`.github/workflows/ci.yml`) | roda em `pull_request`, em push para `main` e em push para `develop` | CI também em `develop`. O job Backend expõe `TEST_INVITE_DATABASE_URL` apontando ao serviço `postgres:17`, para que os testes `*.pg.test.ts` de corrida rodem contra Postgres real. |
| Ruleset da `main` | PR obrigatória; checks obrigatórios `Backend` e `Frontend`; sem force-push; sem deleção | Higiene de produção (spec 4.4). Evidência: resposta da API de branch protection. |
| Proteção da `develop` | recomendada: PR e checks `Backend`/`Frontend` | Promoção `develop → main` só após staging verde. |
| Secrets do repositório | nenhum segredo de produção necessário para o CI | O CI usa só o Postgres descartável do serviço. |
| PR #104 (issuer do MFA) | mesclar após CI verde | Pré-requisito do MFA do operador. |
| Deploy | Railway/Vercel produção a partir de `main`; staging a partir de `develop` | Alinhamento branch ↔ ambiente. |

---

## 4. Conferências e pendências abertas

- **Variáveis exigidas pelo código que não estavam na lista pedida:** `DATABASE_URL`, `DATABASE_SSL`, `SUPABASE_URL`,
  `SUPABASE_PUBLISHABLE_KEY` (a API não sobe sem elas), `CUSTOMER_WEBHOOKS_ENABLED` + `CUSTOMER_WEBHOOK_SECRET`,
  `CUSTOMER_DATA_ENCRYPTION_KEY(_ID)`, `WITHDRAWAL_OPERATOR_USER_IDS` (sem allowlist a API recusa subir com
  aprovações/reembolsos/convites), `RESEND_API_KEY` e as variáveis `INVITE_EMAIL_*`/`PILOT_INVITE_EMAIL_HASH_KEY`,
  `CUSTOMER_RECONCILIATION_ENABLED` (worker), `OZAV_RECONCILIATION_*`, `JOB_*`, `API_RATE_LIMITS_ENABLED`,
  `PILOT_INVITES_ENABLED` e todas as flags `CUSTOMER_*_ENABLED` do caminho live.
- **`ONBOARDING_EMAILS_ENABLED`:** a liberação liga o flag após o deploy com as chaves desligadas e antes do cadastro da pessoa de confiança, com o UUID dela em `ONBOARDING_EMAIL_TEST_USER_IDS`. O código (`notifications/config.ts`) exige `ONBOARDING_EMAIL_TEST_USER_IDS` com
  1 a 5 UUIDs quando ligado; ou seja, o e-mail de resultado de onboarding só chega à allowlist. A spec pede o worker
  de onboarding ligado em produção; para clientes externos, decida (ou ajuste o código) antes do piloto externo. Até lá, só a allowlist recebe.
- **Origem da sessão de KYC:** o host do `session_url` precisa ser `ozav.io` ou `*.ozav.io`; se a OZAV usar outro domínio,
  o KYC live falha fechado até a lista ser atualizada (pendência registrada).
- **ATA do destinatário:** pendência com a OZAV (criação da conta de token); enquanto aberta, o envio é bloqueado pelo
  blocker `DESTINATION_TOKEN_ACCOUNT_MISSING` e `DESTINATION_TOKEN_ACCOUNT_FROZEN` (conta congelada).
- **Piso R$ 50:** redução negociada com a OZAV é apenas configuração (`PURCHASE_MIN_BRL`/`PURCHASE_MAX_BRL`); o lançamento não depende dela.
- Variáveis de uso local/legado que não pertencem a nenhum ambiente hospedado: `SANDBOX_SLOT_RELEASE_CONFIRMATION`,
  `PERAGUS_DEMO_RECIPIENT`, `PERAGUS_DEMO_CORRIDOR_ID`, `OZAV_READINESS_EXPECTED_ENVIRONMENT`, `OZAV_READINESS_API_KEY`, `OZAV_LIVE_PROBE_API_KEY`
  (scripts de linha de comando; nunca definir nos serviços; `OZAV_LIVE_PROBE_API_KEY` só no terminal do responsável, durante o probe `scripts/ozav-live-capabilities.mjs`).
- **Monitor externo de uptime:** `/health` e `/ready` da produção, alertando o operador (evidência: captura da configuração).
