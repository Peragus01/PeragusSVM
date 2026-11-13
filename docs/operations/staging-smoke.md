# Como rodar o smoke de staging

Script: `app/backend/scripts/staging-e2e-smoke.mjs` (Node 22, sem dependências novas). Percorre a jornada completa
contra a **API de staging já implantada** (modo `test`, `solana:devnet`, sandbox da OZAV) e sai com código diferente
de zero na primeira falha, nomeando a etapa. Anexe a saída (sem segredos) ao PR de promoção `develop → main`.

## O que ele nunca faz

- Roda **somente** em `test` + `solana:devnet`. Antes de qualquer outra chamada ele lê
  `GET /v1/me/purchase-capabilities` e recusa se o alvo não reportar `environment=test` e `network=solana:devnet`.
- Recusa se `PERAGUS_DEPLOYMENT_ENV=production` estiver no ambiente do script, ou se **qualquer** variável de
  ambiente começar com `ozav_sk_live_`.
- Não imprime tokens nem dados pessoais: só nome da etapa, rota, status HTTP, códigos de erro, ids e estados.
- Não vincula carteira (exige assinatura de mensagem com a chave privada) e não inventa dados pessoais.

## Pré-requisitos

1. Staging com a configuração de `configuration-checklist.md` (chave `ozav_sk_test_`, RPC devnet, flags de sandbox
   ligadas, `SANDBOX_WITHDRAWAL_EXECUTION_ENABLED` e aprovações de saque ligadas). Em staging use
   `OPERATOR_EXECUTION_MIN_DELAY_SECONDS=0`; com valor maior o script espera o intervalo (`EXECUTION_TOO_EARLY`).
2. **Conta de cliente de teste** já criada (convite resgatado), com o **rascunho do cadastro individual** salvo no app
   usando dados sintéticos. O script confirma a atestação de dados de teste (`sandbox_data_confirmed`) ao enviar.
3. **Carteira devnet já vinculada** pelo app, com **conta de token (ATA) do USDT de teste** criada. Se já estiver
   vinculada e quiser pular a checagem, use `--skip-wallet`.
4. **Conta de operador separada** (não pode ter cadastro de cliente) com MFA configurado (AAL2).
5. Nenhuma operação aberta para o cliente de teste e nenhuma outra operação aberta no ambiente
   (`PURCHASE_MAX_OPEN_GLOBAL=1`).

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `STAGING_API_BASE_URL` | sim | Origem HTTPS da API de staging (http só em localhost) |
| `STAGING_CUSTOMER_TOKEN` | sim | JWT do cliente de teste |
| `STAGING_OPERATOR_TOKEN` | sim\* | JWT do operador (AAL2) com TOTP recente |
| `STAGING_OPERATOR_TOKEN_FILE` | alternativa | Arquivo com o JWT do operador, relido quando a MFA expira |
| `STAGING_SKIP_WALLET_CHECK=1` | não | Mesmo efeito de `--skip-wallet` |
| `STAGING_SMOKE_STEP_TIMEOUT_SECONDS` | não | Tempo limite por etapa de espera (padrão 180) |
| `STAGING_SMOKE_POLL_INTERVAL_MS` | não | Intervalo de consulta (padrão 3000) |

Nunca cole os tokens em chat, tickets ou logs. Não defina `PERAGUS_DEPLOYMENT_ENV=production` nem chaves
`ozav_sk_live_` no shell onde roda o smoke.

## Rodando

```bash
cd app/backend
export STAGING_API_BASE_URL=...        # origem do staging
export STAGING_CUSTOMER_TOKEN=...
export STAGING_OPERATOR_TOKEN=...      # TOTP de no máximo 300 s
node scripts/staging-e2e-smoke.mjs     # ou: ... --skip-wallet
```

**MFA do operador:** aprovar, executar, ligar/desligar chaves e registrar revisão exigem TOTP de no máximo 300 s.
Se o backend responder `OPERATOR_MFA_STALE`, o script pede (terminal interativo, entrada oculta) um token novo, ou
espera você atualizar `STAGING_OPERATOR_TOKEN_FILE`, e repete **uma vez** a mesma solicitação com o **mesmo**
`request_id`. Sem terminal interativo, falha nomeando a etapa. Comece com um token recém-emitido.

## Etapas

1. Guarda (modo do alvo). 2. Lê as chaves de runtime e **liga** `onboarding`, `new_operations`, `usdt_sends`
(com motivo) — só as que estavam desligadas. 3. Revisão diária de ontem (São Paulo), se houve atividade e não foi
revisada (`GET/POST /v1/admin/daily-reviews`). 4. Aceite jurídico (`GET/POST /v1/me/legal-acceptances`).
5. Onboarding e KYC simulado (termos, envio, `verification/simulate`, triagem, atualizações). 6. Confere a carteira
(`GET /v1/me/wallet`). 7. Cotação de R$ 1.000,00, aceite, criação do Pix, simulação do pagamento e espera da
conversão. 8. Registro do pedido de saque, espera de `awaiting_approval` e **aprovação** com motivo. 9. **Execução**
(`SANDBOX_ONLY`), respeitando o intervalo mínimo. 10. Conciliação até a entrega `verified` ou `simulated`.
11. Imprime o estado final da operação, o resultado da conciliação e os ids.

**Sempre** (bloco `finally`) as chaves que o script ligou são desligadas de novo, mesmo após falha. Se isso não for
possível (por exemplo MFA expirada sem terminal), o script avisa e sai com erro: desligue pelo console do operador.

## Se falhar

A mensagem informa a etapa e o código (`DAILY_REVIEW_REQUIRED`, `OPERATIONS_PAUSED`,
`DESTINATION_TOKEN_ACCOUNT_MISSING`, ...). Consulte `operator-runbook.md`. Nunca repita à mão uma ação de dinheiro
com resultado incerto (`recovery_required`): use **Saques → Detalhes → Conciliar**.
