# Runbook do operador — operação diária

Para o operador único. Cobre: chaves de runtime, revisão diária, aprovação e execução de envio, reembolso,
tratamento de `needs_review` e alertas, e a semântica do cancelamento pelo cliente. Os códigos de motivo abaixo
são os que o código emite hoje (`app/backend/src`); se aparecer um código que não está aqui, trate como
`needs_review` genérico e não reenvie nada.

## 0. Princípios

- **Dinheiro real só se move por ação explícita do operador.** Nada é reenviado automaticamente: toda ação de dinheiro
  (POST à OZAV) tem uma única tentativa persistida antes da chamada; resposta ambígua vira leitura (GET), nunca novo POST.
- **MFA fresco.** Aprovar, executar, decidir/registrar reembolso, mudar chave e registrar revisão diária exigem TOTP
  verificado há no máximo 300 s (`OPERATOR_MFA_MAX_AGE_SECONDS`). Erro `OPERATOR_MFA_STALE`: refaça o TOTP (login/MFA
  de novo) e repita a mesma ação com o **mesmo** `request_id` (a operação é idempotente).
- **Conta de operador ≠ conta de cliente.** Uma conta com cadastro de cliente nunca age como operador
  (`OPERATOR_ACCOUNT_SEPARATION_REQUIRED`).
- **Pessoa de confiança** recebe por e-mail: aprovação, execução, `needs_review`, reembolso e mudança de chave.
  Se um e-mail não corresponder a nada que você fez, pause tudo (seção 1) e investigue.
- **Prazos da política de reembolso (24 h):** regularização de entrega, execução de reembolso e primeira resposta ao cliente.
- Autenticação nos exemplos abaixo: `Authorization: Bearer <JWT-do-operador-com-AAL2>`; `API` é a origem HTTPS da API de produção.
  Nunca cole o JWT, chaves ou URLs reais em chat, tickets ou logs.

## 1. Chaves de runtime (kill switches)

Chaves: `new_operations` (cotação, aceite, Pix), `usdt_sends` (claim do envio; aprovação continua permitida),
`onboarding` (envio de cadastro e início de KYC). Para agir, a flag de ambiente **e** a chave precisam permitir.
Pausar **não cancela nem move** operações em andamento; reconciliação, reembolsos e leituras nunca são bloqueados.
Uma chave ausente é lida como pausada. Em produção todas começam desligadas.

Ver o estado:

```bash
curl -s "$API/v1/admin/runtime-controls" -H "Authorization: Bearer $OPERATOR_JWT"
```

Ligar ou desligar (motivo de 1 a 500 caracteres, obrigatório; gera auditoria e e-mail à pessoa de confiança):

```bash
curl -s -X PUT "$API/v1/admin/runtime-controls" \
  -H "Authorization: Bearer $OPERATOR_JWT" -H "Content-Type: application/json" \
  -d '{"key":"usdt_sends","enabled":false,"reason":"Pausa preventiva: motivo em uma frase"}'
```

Resposta traz `changed:true|false`. Pausar é sempre seguro e deve ser a primeira reação a qualquer dúvida
financeira. Ordem de abertura (ver `internal-transaction-runbook.md`): `onboarding` → `new_operations` → `usdt_sends`,
uma por vez. Recusas que o cliente/operador verá: `OPERATIONS_PAUSED` (com a chave) e `DAILY_REVIEW_REQUIRED` (com o dia).

## 2. Revisão diária (apenas para dias encerrados)

Se o dia anterior (fuso `America/Sao_Paulo`) teve atividade de operação e não foi revisado, **novas operações ficam
bloqueadas** (`DAILY_REVIEW_REQUIRED`) e o scanner envia o alerta `daily_review_missing` (alta). O dia corrente **não** pode ser revisado
(`DAILY_REVIEW_DAY_NOT_ENDED`, HTTP 409): um dia só é revisado depois de terminar, para que nenhuma operação posterior escape.

1. Leia as pendências: `GET /v1/admin/operational-alerts` (opcional `?severity=high`), `GET /v1/admin/customer-reconciliation`,
   `GET /v1/admin/withdrawal-requests?state=all` e `GET /v1/admin/refund-requests?state=all`.
2. Confirme que, para o dia: BRL pago ↔ transfer 1 ↔ transfer 2 ↔ transação on-chain fecham; nenhum `needs_review`,
   `refund_pending` ou alerta de Pix aberto sem tratamento; nenhuma notificação `failed`/`uncertain` sem explicação.
3. Registre (TOTP fresco; idempotente por dia):

```bash
curl -s -X POST "$API/v1/admin/daily-reviews" \
  -H "Authorization: Bearer $OPERATOR_JWT" -H "Content-Type: application/json" \
  -d '{"day":"2026-11-14","note":"Conciliação fechada; sem pendências"}'
```

`note` é opcional (até 500 caracteres). A linha gravada é a auditoria. Dia sem atividade não exige revisão.

## 3. Aprovar e executar um envio de USDT

Fluxo normal: Pix pago → transfer 1 `completed` → operação `awaiting_approval` automaticamente → **aprovação** →
(espera mínima) → **execução** → `sending` → `sent` → verificação on-chain `finalized` → `delivered_verified`.

1. **Fila:** `GET /v1/admin/withdrawal-requests` (padrão `pending_approval`; filtros `approved`, `reserved`, `uncertain`,
   `processing`, `completed`, `needs_review`, `all`). Abra a trilha: `GET /v1/admin/withdrawal-requests/{id}/audit`.
   Confira valor travado, carteira de destino (a verificada por assinatura), Pix confirmado e mint da Mainnet.
2. **Aprovar** (TOTP ≤ 300 s; `reason` de 10 a 300 caracteres; `request_id` UUID novo e guardado):

```bash
curl -s -X POST "$API/v1/admin/withdrawal-requests/$ID/approval" \
  -H "Authorization: Bearer $OPERATOR_JWT" -H "Content-Type: application/json" \
  -d '{"request_id":"<uuid-novo>","reason":"Conferido Pix, trava e carteira"}'
```

3. **Intervalo mínimo:** a execução só é aceita após `OPERATOR_EXECUTION_MIN_DELAY_SECONDS` (padrão 900 s = 15 min),
   medido pelo relógio do banco desde a aprovação. Antes disso: `EXECUTION_TOO_EARLY` (aguarde, não é falha).
   Com quatro olhos ligado, o executor precisa ser outro operador (`EXECUTION_REQUIRES_SECOND_OPERATOR`); desligado por padrão.
4. **Executar** (TOTP **fresco** de novo; a confirmação em live é literalmente `LIVE_USDT_SEND`):

```bash
curl -s -X POST "$API/v1/admin/withdrawal-requests/$ID/execution" \
  -H "Authorization: Bearer $OPERATOR_JWT" -H "Content-Type: application/json" \
  -d '{"request_id":"<uuid-novo>","confirmation":"LIVE_USDT_SEND"}'
```

   Resposta 201 = enviado; 200 = repetição idempotente; **202 = `recovery_required`** (resposta ambígua da OZAV: não repita o POST;
   use a leitura/reconciliação abaixo). Clique duplo ou repetição geram exatamente um POST à OZAV.
5. **Acompanhar:** `GET .../execution` (leitura) e `POST .../execution/reconcile` (reconciliação somente por GET).
   Alerta `stuck_operation` se ficar `sending` > 30 min ou `sent` > 30 min sem verificação on-chain.
6. **Conferir a entrega:** `delivered_verified` só ocorre com entrega `finalized` na Mainnet, mint canônico, destinatário
   dono da carteira verificada, valor entre (travado − 0,10 USDT) e travado, e igual ao valor líquido que a OZAV reporta.

### Bloqueios antes do envio (conta de token)

| Código | Significado | O que fazer |
|---|---|---|
| `DESTINATION_TOKEN_ACCOUNT_MISSING` | A carteira de destino não tem conta de token (ATA) do USDT | Nada é enviado. Peça à OZAV a criação da ATA (pendência em aberto) ou ao cliente que crie a ATA (receber 1 USDT/abrir conta na carteira) e execute de novo. |
| `DESTINATION_TOKEN_ACCOUNT_FROZEN` | A ATA existe mas está congelada: não pode receber | Não adianta repetir. Tratar como caso de revisão: contato com o cliente/emissor; reembolso se não houver solução. |
| `DESTINATION_TOKEN_ACCOUNT_UNVERIFIED` / `DESTINATION_TOKEN_ACCOUNT_CHECK_REQUIRED` | O RPC não respondeu / verificação indisponível | Confira `SOLANA_RPC_URL`/`/ready` e tente de novo; nenhum POST foi feito. |
| `DESTINATION_IDENTIFICATION_FAILED` | A identificação do destino na OZAV falhou (`provider_http_status` na resposta) | Nada foi enviado; leia o status, corrija o dado ou contate a OZAV. |
| `WITHDRAWAL_EXECUTION_CONTEXT_MISMATCH` | Valor ou carteira divergem do contexto validado | Recusado antes de qualquer POST. Não force: investigar como `needs_review`. |
| `OPERATIONS_PAUSED` (chave `usdt_sends`) | Envio pausado | Religar a chave (seção 1) quando for deliberado. |

## 4. Reembolso

A política publicada compromete **24 h**. O reembolso do Pix é **executado pela OZAV a pedido manual do operador**
(a OZAV não tem caminho automático); o sistema só **registra** decisão e conclusão (`record_only`, nenhum Pix sai do sistema).
O alerta `refund_pending` dispara em 12 h (atenção) e 20 h (alta) desde a entrada em `refund_pending`.

1. **Decidir o reembolso** de uma operação (TOTP fresco). Origem permitida: `needs_review`, `pix_confirmed`, `converted`,
   `awaiting_approval`, ou `expired`/`failed` com o Pix **efetivamente pago**. É recusado se já existe aprovação/execução de envio
   (`REFUND_WITHDRAWAL_IN_PROGRESS`) ou se o pagamento não foi confirmado (`REFUND_PAYMENT_NOT_CONFIRMED`). A operação passa a `refund_pending`.
   Pelo console `operador.estornos` (rota `/operador/estornos`) ou pela API:

```bash
curl -s -X POST "$API/v1/admin/operations/$PURCHASE_ID/refund-decision" \
  -H "Authorization: Bearer $OPERATOR_JWT" -H "Content-Type: application/json" \
  -d '{"request_id":"<uuid-novo>","reason":"Motivo do reembolso (10 a 500 caracteres)"}'
```

2. **Executar o reembolso: peça manualmente à OZAV** (canal de suporte/contato combinado) a devolução do valor pago ao pagador
   original, informando a operação e o valor. **Nenhum botão do sistema devolve dinheiro.** Anote a referência que a OZAV fornecer.
3. **Registrar a conclusão em até 24 h** com a referência da OZAV (8 a 160 caracteres), o valor devolvido (até o valor pago;
   parcial é permitido e fica marcado) e a confirmação literal. Move `refund_pending → refunded`:

```bash
curl -s -X POST "$API/v1/admin/refund-requests/$REFUND_REQUEST_ID/completion" \
  -H "Authorization: Bearer $OPERATOR_JWT" -H "Content-Type: application/json" \
  -d '{"request_id":"<uuid-novo>","amount_brl":"1000.00","reference":"<referencia-da-OZAV>","confirmation":"MANUAL_REFUND_EXECUTED_EXTERNALLY"}'
```

   Liste pedidos: `GET /v1/admin/refund-requests?state=pending_review|approved|rejected|refund_recorded|all`.
   Requer `MANUAL_REFUNDS_ENABLED=true` (`MANUAL_REFUNDS_DISABLED` caso contrário; a decisão sobre operação é registrada mesmo assim).
4. Se passar de **12 h** sem conclusão, aja agora; aos **20 h** o prazo de 24 h está em risco: ligue para a OZAV.
5. Pedido de reembolso aberto pelo cliente (`POST /v1/me/operations/:id/refund-request`) aparece como `pending_review` e como alerta `refund_pending_review`;
   a decisão `approved`/`rejected` da trilha legada usa `POST /v1/admin/refund-requests/{id}/decision` (`confirmation: "MANUAL_REVIEW_COMPLETED"`).

## 5. Tratamento de `needs_review`

`needs_review` nunca é terminal e **nunca é entrega verificada**. O alerta escala em 4 h (atenção) e 12 h (alta) — resolva
antes de 24 h (política). Veja a operação em `GET /v1/admin/customer-reconciliation` e a trilha de auditoria. **Regra geral:
antes de qualquer decisão que mova dinheiro, consulte a OZAV (painel/GET) e confirme o estado real; nunca reenvie por reflexo.**

| Código do motivo | Origem | O que significa | Ação |
|---|---|---|---|
| `OZAV_TRANSFER_NEEDS_REVIEW` | Progressão da compra: a transfer do Pix ficou `needs_review` na OZAV (estado não terminal) | A OZAV está revisando o pagamento/conversão. Não é reembolso automático. | Acompanhe com a OZAV. Se a OZAV concluir, a operação retoma sozinha (→ `pix_confirmed`/`converted`). Se a OZAV falhar/cancelar após o recebimento, ou você decidir devolver, faça a decisão de reembolso (seção 4). Não reembolse enquanto a OZAV ainda pode concluir (risco de perda dupla). |
| `PIX_LOCK_OUTCOME_UNKNOWN: transfer_status=...` | Pix: o estado da trava de câmbio não pôde ser confirmado | Não se sabe se a trava valeu; o Pix pode estar pago. | Consulte a transfer na OZAV. Se pago e trava válida, retome com a OZAV; se pago sem trava utilizável ou falhou, decisão de reembolso. Alerta `pix_open_after_close` pode acompanhar. |
| `LOCKED_AMOUNT_MISMATCH: facility.amount=... locked_usdt_amount=...` | Pix: o valor da trava da OZAV difere do USDT aceito pelo cliente | O Pix **não** foi exibido ao cliente. A transfer pode ficar `awaiting_payment` com BR Code válido do lado da OZAV. | Confirme com a OZAV que a transfer não será paga/cancele-a; verifique se não houve pagamento. Se houve, reembolso. Investigar a divergência antes de liberar novas operações. |
| `TX_ALREADY_USED` | Verificação on-chain: o `tx_hash` informado já verificou outra operação | Uma transação não pode comprovar duas entregas. | Não marque entregue. Compare os dois `tx_hash` no Explorer; peça à OZAV o `tx_hash` correto. Operação fica em revisão até a OZAV esclarecer; se a entrega não ocorreu, siga a regra do envio (seção 6). |
| `TX_PREDATES_SEND` | Verificação on-chain: a transação é anterior ao envio, ou o RPC não devolveu `blockTime` | Pode ser hash errado ou RPC sem `blockTime` (a Mainnet exige RPC que o devolva). | Confira `SOLANA_RPC_URL`; abra a transação no Explorer e confirme data/valor/destino; peça à OZAV o hash correto. Só marque entrega após verificação válida. |
| `ONCHAIN_CREDIT_DIFFERS_FROM_SETTLED` | Verificação: o crédito on-chain difere do valor líquido que a OZAV liquidou (ruling 30) | Divergência entre a chain e o relatório da OZAV. | A chain é a verdade. Registre as duas quantias, abra caso com a OZAV; não aprove entrega. Diferença pequena dentro da tolerância não basta se for diferente do líquido liquidado. |
| `TRAVEL_RULE_REQUIRED` (resposta definitiva da OZAV; erro `WITHDRAWAL_SEND_REFUSED` com `provider_code`) | O envio foi **recusado** definitivamente (400/401/403/422); o sistema nunca reenvia | A OZAV recusou antes de criar a transfer. Mas pode existir transfer mesmo assim. | **Ruling 28:** (1) o sistema faz uma busca somente-leitura por metadata; se achar transfer, alerta `withdrawal_refused_transfer_found` (alta) e **nada é vinculado ou reenviado**; (2) **confirme com a OZAV, por escrito, que nenhuma transfer existe** para esta operação; (3) só então um reenvio pode ser considerado — não há botão: é decisão manual, com apoio do desenvolvedor, e jamais com a mesma chave sem essa confirmação; (4) se não for possível enviar, siga a decisão de reembolso com a OZAV. Um 404 **não** é recusa definitiva: permanece `sending` e é recuperado por GET. |

Para qualquer `needs_review`, registre na revisão diária: operação, causa, quem foi contatado na OZAV, desfecho.

## 6. Alertas específicos

- **`pix_open_after_close` (alta):** a operação já está `failed`/`expired`, mas a transfer da OZAV continua pagável, foi paga ou
  concluída. A OZAV **não tem endpoint de cancelamento**; o dinheiro pode estar em custódia. Consulte a transfer; se
  houver pagamento, faça a decisão de reembolso (seção 4); se estiver apenas aberta, acompanhe até expirar e confirme que não foi paga.
  O alerta some quando existe decisão de reembolso.
- **`withdrawal_refused_transfer_found` (alta):** o envio foi dado como recusado, mas existe uma transfer na OZAV (achada por metadata, só GET).
  O dinheiro pode ter saído. Não reenvie, não vincule. Abra a transfer na OZAV, veja o estado e o `tx_hash`, e decida com a OZAV (verificar entrega
  manualmente ou reembolso). Registre na revisão diária.
- **`stuck_operation`:** `sending`/`sent` > 30 min, ou `awaiting_pix` após o prazo do Pix/trava. Reconcilie (`.../execution/reconcile`) antes de agir.
- **`webhook_signature_invalid`:** webhook com assinatura inválida: confira o `CUSTOMER_WEBHOOK_SECRET` e o endpoint na OZAV; repetição pode ser tentativa de fraude.
- **`reconciliation_mismatch`:** divergência na conciliação: tratar como `needs_review`.
- **`daily_review_missing`:** seção 2.

## 7. Cancelamento pelo cliente

O cliente pode pedir cancelamento **antes da confirmação do Pix**. Isso **não encerra** a operação: grava o pedido
(`CUSTOMER_CANCEL_REQUESTED`), esconde as instruções de Pix e a operação segue `awaiting_pix` até expirar (o que vier primeiro entre expiração do Pix e da trava).
Se o pagamento for confirmado (GET) antes, o pedido é considerado **desistido**: a operação **prossegue normalmente**
(`CUSTOMER_CANCEL_WITHDRAWN_BY_PAYMENT`). Pagamento depois da expiração segue o caminho de Pix aberto após encerramento
(`pix_open_after_close` e reembolso). O slot de operação aberta continua ocupado até a expiração: o cliente aguarda para
nova compra. Não existe cancelamento manual de transfer na OZAV.

## 8. Rotina diária resumida

1. Abra `/ready` e `/health`; confira que o monitor de uptime não alertou.
2. Revise o dia anterior (seção 2) e registre.
3. `GET /v1/admin/operational-alerts` — nada em aberto sem dono.
4. Fila de envio e de reembolsos; nenhum `refund_pending` com mais de 12 h.
5. Confirme e-mails de alerta recebidos pela pessoa de confiança (notificações `failed`/`uncertain` indicam problema no Resend).
6. Mudou algo (chave, configuração)? Registre o motivo e o horário.
