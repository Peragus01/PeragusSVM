# Runbook do operador — operação diária

Para o operador único. Cobre: chaves de runtime, revisão diária, aprovação e execução de envio, reembolso,
tratamento de `needs_review` e alertas, e a semântica do cancelamento pelo cliente. Os códigos de motivo abaixo
são os que o código emite hoje (`app/backend/src`); se aparecer um código que não está aqui, trate como
`needs_review` genérico e não reenvie nada.

**Toda a operação do piloto é feita pelo console do operador** (`/operador`, no frontend). O `curl` fica como
alternativa de contingência no [Apêndice A](#apêndice-a--api-direta-contingência), para quando o frontend estiver fora.

## Console do operador

| Tela | Rota | Para quê | API usada |
|---|---|---|---|
| Painel | `/operador` | Estado das chaves, estado da revisão de ontem, saques/estornos abertos por situação, alertas de alta gravidade | `GET runtime-controls`, `GET daily-reviews?day=<ontem>`, `GET withdrawal-requests?state=all`, `GET refund-requests?state=all`, `GET operational-alerts?severity=high` |
| Controles | `/operador/controles` | Ligar/desligar `new_operations`, `usdt_sends`, `onboarding` (motivo obrigatório + confirmação) | `GET/PUT /v1/admin/runtime-controls` |
| Revisão diária | `/operador/revisao-diaria` | Registrar a revisão de um dia **encerrado** (São Paulo) | `POST /v1/admin/daily-reviews` (consulta: `GET ?day=`) |
| Saques | `/operador/saques` | Fila; **Aprovar** (motivo), **Executar** (confirmação; em produção digitar `LIVE_USDT_SEND`), **Detalhes** (verificação de entrega, motivo de revisão, link do explorer, **Conciliar**) | `GET withdrawal-requests`, `POST .../approval`, `GET/POST .../execution`, `POST .../execution/reconcile` |
| Estornos | `/operador/estornos` | Decisão de estorno pela operação, análise de pedidos do cliente, registro da devolução com a referência da OZAV, contagem do prazo de 24 h | `POST /v1/admin/operations/:id/refund-decision`, `GET refund-requests`, `POST .../decision`, `POST .../completion` |
| Alertas | `/operador/alertas` | Alertas operacionais e notificações por e-mail `uncertain`/`failed` | `GET /v1/admin/operational-alerts`, `GET /v1/admin/operator-notifications` |
| Convites | `/operador/convites` | Convites do piloto | `/v1/admin/pilot-invites` |

Como o console se comporta:

- Entre com a **conta separada de operador**. Uma conta com cadastro de cliente é recusada na tela e no backend.
- Se o backend pedir MFA (`WITHDRAWAL_OPERATOR_MFA_REQUIRED`), a tela mostra o campo do código (e, na primeira vez,
  **Configurar autenticador**). Ações de dinheiro, chaves e revisão diária exigem TOTP de no máximo 300 s: se o backend
  responder `OPERATOR_MFA_STALE`, a tela pede um **código atual** e repete **uma única vez** a mesma solicitação, com o
  **mesmo `request_id`**. Um segundo `OPERATOR_MFA_STALE` é só exibido. Na fila de saques, enquanto uma aprovação ou
  execução está em andamento ou sem resultado confirmado, as outras linhas, o filtro e o Cancelar ficam bloqueados; se
  você sair da tela nesse estado, a próxima visita avisa qual saque conferir antes de qualquer nova ação.
- Toda ação de dinheiro tem um passo de confirmação e usa um `request_id` novo por intenção. Se o resultado for incerto
  (rede/5xx), a tela oferece apenas **Repetir mesma solicitação** (mesma chave de idempotência), nunca uma nova.
- Mensagens em português; o código do backend aparece em uma linha secundária ("Código: ...").
- Carteiras aparecem abreviadas (início…fim); o console não mostra dados pessoais além do que a API já devolve.

## 0. Princípios

- **Dinheiro real só se move por ação explícita do operador.** Nada é reenviado automaticamente: toda ação de dinheiro
  (POST à OZAV) tem uma única tentativa persistida antes da chamada; resposta ambígua vira leitura (GET), nunca novo POST.
- **MFA fresco.** Aprovar, executar, decidir/registrar reembolso, mudar chave e registrar revisão diária exigem TOTP
  verificado há no máximo 300 s (`OPERATOR_MFA_MAX_AGE_SECONDS`). Erro `OPERATOR_MFA_STALE`: confirme um código atual
  (o console faz isso e repete com o **mesmo** `request_id`; a operação é idempotente).
- **Conta de operador ≠ conta de cliente.** Uma conta com cadastro de cliente nunca age como operador
  (`OPERATOR_ACCOUNT_SEPARATION_REQUIRED`).
- **Pessoa de confiança** recebe por e-mail: aprovação, execução, `needs_review`, reembolso e mudança de chave.
  Se um e-mail não corresponder a nada que você fez, pause tudo (seção 1) e investigue.
- **Prazos da política de reembolso (24 h):** regularização de entrega, execução de reembolso e primeira resposta ao cliente.
- Nunca cole o JWT, chaves ou URLs reais em chat, tickets ou logs.

## 1. Chaves de runtime (kill switches) — `/operador/controles`

Chaves: **Novas operações** (`new_operations`: cotação, aceite, Pix), **Envios de USDT** (`usdt_sends`: claim do envio;
aprovação continua permitida), **Cadastros** (`onboarding`: envio de cadastro e início de KYC). Para agir, a flag de
ambiente **e** a chave precisam permitir. Pausar **não cancela nem move** operações em andamento; reconciliação,
reembolsos e leituras nunca são bloqueados. Uma chave ausente é lida como pausada. Em produção todas começam desligadas.

Na tela: **Ligar/Desligar** → informe o **Motivo da alteração** (1 a 500 caracteres) → **Confirmar alteração**. A mudança
gera auditoria e e-mail à pessoa de confiança; a resposta indica se a chave já estava no estado pedido. O backend não
expõe o histórico de alterações pela API (fica na tabela de eventos e nos e-mails).

Pausar é sempre seguro e deve ser a primeira reação a qualquer dúvida financeira. Ordem de abertura (ver
`internal-transaction-runbook.md`): `onboarding` → `new_operations` → `usdt_sends`, uma por vez. Recusas que o
cliente/operador verá: `OPERATIONS_PAUSED` (com a chave) e `DAILY_REVIEW_REQUIRED` (com o dia). O cliente vê
"Operações temporariamente pausadas…" ou "Operações temporariamente indisponíveis enquanto concluímos a revisão diária…".

## 2. Revisão diária (apenas para dias encerrados) — `/operador/revisao-diaria`

Se o dia anterior (fuso `America/Sao_Paulo`) teve atividade de operação e não foi revisado, **novas operações ficam
bloqueadas** (`DAILY_REVIEW_REQUIRED`) e o scanner envia o alerta `daily_review_missing` (alta). O dia corrente **não** pode ser revisado
(`DAILY_REVIEW_DAY_NOT_ENDED`, HTTP 409; a tela recusa antes de enviar): um dia só é revisado depois de terminar, para que nenhuma operação posterior escape.

1. Leia as pendências no console: **Alertas** (alertas e notificações `failed`/`uncertain`), **Saques** (filtro "Todas"),
   **Estornos**; a conciliação detalhada continua em `GET /v1/admin/customer-reconciliation` (Apêndice A).
2. Confirme que, para o dia: BRL pago ↔ transfer 1 ↔ transfer 2 ↔ transação on-chain fecham; nenhum `needs_review`,
   `refund_pending` ou alerta de Pix aberto sem tratamento; nenhuma notificação `failed`/`uncertain` sem explicação.
3. Registre na tela: o dia vem preenchido com **ontem**; **Observação (opcional)** até 500 caracteres → **Registrar revisão**.
   É idempotente por dia: repetir mostra quando a revisão foi feita. O **Painel** mostra o estado de ontem (revisada em …,
   revisão pendente com atividade, ou sem atividade) via `GET /v1/admin/daily-reviews?day=`. Dia sem atividade não exige revisão.

## 3. Aprovar e executar um envio de USDT — `/operador/saques`

Fluxo normal: Pix pago → transfer 1 `completed` → operação `awaiting_approval` automaticamente → **aprovação** →
(espera mínima) → **execução** → `sending` → `sent` → verificação on-chain `finalized` → `delivered_verified`.

1. **Fila:** situações "Aguardando aprovação" (`pending_approval`), "Aprovado" (`approved`), "Reservado para envio"
   (`reserved`), "Envio com resultado incerto" (`uncertain`), "Em envio" (`processing`), "Enviado pelo provedor"
   (`completed`), "Em revisão" (`needs_review`), "Todas". Cada linha mostra valor em USDT, carteira abreviada e data.
   A trilha completa continua em `GET /v1/admin/withdrawal-requests/{id}/audit` (Apêndice A).
   Confira valor travado, carteira de destino (a verificada por assinatura), Pix confirmado e mint da Mainnet.
2. **Aprovar:** **Motivo da aprovação** (10 a 300 caracteres) → **Confirmar aprovação** (TOTP ≤ 300 s).
3. **Intervalo mínimo:** a execução só é aceita após `OPERATOR_EXECUTION_MIN_DELAY_SECONDS` (padrão 900 s = 15 min),
   medido pelo relógio do banco desde a aprovação. Antes disso o backend responde `EXECUTION_TOO_EARLY` com
   `remaining_delay_seconds` e a tela mostra "faltam N min" (aguarde, não é falha; nada foi enviado).
   Com quatro olhos ligado, o executor precisa ser outro operador (`EXECUTION_REQUIRES_SECOND_OPERATOR`); desligado por padrão.
4. **Executar:** em produção a tela avisa que move dinheiro real e exige digitar `LIVE_USDT_SEND`; em testes a
   confirmação é `SANDBOX_ONLY`. TOTP **fresco** de novo. Resultado incerto (202 `recovery_required` ou
   `WITHDRAWAL_EXECUTION_REQUIRES_RECOVERY`): **não** faça nova intenção; use **Detalhes → Conciliar**.
   Clique duplo ou repetição geram exatamente um POST à OZAV.
5. **Acompanhar:** **Detalhes** mostra a verificação de entrega ("Entrega verificada on-chain", "Envio simulado",
   "Entrega em revisão", "Entrega ainda não verificada"), o motivo com explicação curta e o código, a recusa do provedor,
   e o link do explorer da rede do ambiente (mainnet em produção, devnet em testes). **Conciliar** só consulta a OZAV (GET).
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

## 4. Reembolso — `/operador/estornos`

A política publicada compromete **24 h**. O reembolso do Pix é **executado pela OZAV a pedido manual do operador**
(a OZAV não tem caminho automático); o sistema só **registra** decisão e conclusão (`record_only`, nenhum Pix sai do sistema).
O alerta `refund_pending` dispara em 12 h (atenção) e 20 h (alta) desde a entrada em `refund_pending`. A tela mostra
"Prazo de 24 h: restam …" em cada pedido aberto (contado da decisão, ou do pedido se ainda não decidido), destacado a
partir de 12 h (atenção) e 20 h (alta).

1. **Decidir o reembolso** de uma operação (painel **Decisão de estorno pela operação**; TOTP fresco). Os links
   **Decidir estorno** (Saques) e **Abrir estornos** (Alertas) preenchem o **ID da operação**. Informe o **Motivo do
   estorno** (10 a 500 caracteres) → **Registrar decisão de estorno** → **Confirmar estorno**. Origem permitida:
   `needs_review`, `pix_confirmed`, `converted`, `awaiting_approval`, ou `expired`/`failed` com o Pix **efetivamente pago**.
   É recusado se já existe aprovação/execução de envio (`REFUND_WITHDRAWAL_IN_PROGRESS`) ou se o pagamento não foi
   confirmado (`REFUND_PAYMENT_NOT_CONFIRMED`). A operação passa a `refund_pending`.
2. **Executar o reembolso: peça manualmente à OZAV** (canal de suporte/contato combinado) a devolução do valor pago ao pagador
   original, informando a operação e o valor. **Nenhum botão do sistema devolve dinheiro.** Anote a referência que a OZAV fornecer.
3. **Registrar a conclusão em até 24 h:** em **Analisar pedido** de um pedido aprovado, informe **Valor devolvido (R$)**
   (até o valor pago; parcial é permitido e fica marcado) e **Referência OZAV** (8 a 160 caracteres), marque a confirmação
   de que a devolução foi executada fora da Peragus → **Registrar devolução** → **Confirmar registro**. Move `refund_pending → refunded`.
   Requer `MANUAL_REFUNDS_ENABLED=true` (`MANUAL_REFUNDS_DISABLED` caso contrário; a decisão sobre operação é registrada mesmo assim).
4. Se passar de **12 h** sem conclusão, aja agora; aos **20 h** o prazo de 24 h está em risco: ligue para a OZAV.
5. Pedido de reembolso aberto pelo cliente aparece como "Em análise" (`pending_review`) e como alerta `refund_pending_review`;
   a decisão aprovar/não aprovar fica em **Analisar pedido** (confirmação `MANUAL_REVIEW_COMPLETED`).

## 5. Tratamento de `needs_review`

`needs_review` nunca é terminal e **nunca é entrega verificada**. O alerta escala em 4 h (atenção) e 12 h (alta) — resolva
antes de 24 h (política). Veja a operação em **Saques → Detalhes**, em `GET /v1/admin/customer-reconciliation` e na trilha de auditoria. **Regra geral:
antes de qualquer decisão que mova dinheiro, consulte a OZAV (painel/GET) e confirme o estado real; nunca reenvie por reflexo.**

| Código do motivo | Origem | O que significa | Ação |
|---|---|---|---|
| `OZAV_TRANSFER_NEEDS_REVIEW` | Progressão da compra: a transfer do Pix ficou `needs_review` na OZAV (estado não terminal) | A OZAV está revisando o pagamento/conversão. Não é reembolso automático. | Acompanhe com a OZAV. Se a OZAV concluir, a operação retoma sozinha (→ `pix_confirmed`/`converted`). Se a OZAV falhar/cancelar após o recebimento, ou você decidir devolver, faça a decisão de reembolso (seção 4). Não reembolse enquanto a OZAV ainda pode concluir (risco de perda dupla). |
| `PIX_LOCK_OUTCOME_UNKNOWN: transfer_status=...` | Pix: o estado da trava de câmbio não pôde ser confirmado | Não se sabe se a trava valeu; o Pix pode estar pago. | Consulte a transfer na OZAV. Se pago e trava válida, retome com a OZAV; se pago sem trava utilizável ou falhou, decisão de reembolso. Alerta `pix_open_after_close` pode acompanhar. |
| `LOCKED_AMOUNT_MISMATCH: facility.amount=... locked_usdt_amount=...` | Pix: o valor da trava da OZAV é menor que o USDT aceito pelo cliente | A operação vai para **`failed`** (código ao cliente `PIX_LOCKED_AMOUNT_MISMATCH`) e o Pix **não** é exibido. A transfer pode ficar `awaiting_payment` com BR Code válido do lado da OZAV. | Confirme com a OZAV que a transfer não será paga/cancele-a; verifique se não houve pagamento. Se houve, reembolso. Investigar a divergência antes de liberar novas operações. |
| `TX_ALREADY_USED` | Verificação on-chain: o `tx_hash` informado já verificou outra operação | Uma transação não pode comprovar duas entregas. | Não marque entregue. Compare os dois `tx_hash` no Explorer; peça à OZAV o `tx_hash` correto. Operação fica em revisão até a OZAV esclarecer; se a entrega não ocorreu, siga a regra do envio (seção 6). |
| `TX_PREDATES_SEND` | Verificação on-chain: a transação é anterior ao envio, ou o RPC não devolveu `blockTime` | Pode ser hash errado ou RPC sem `blockTime` (a Mainnet exige RPC que o devolva). | Confira `SOLANA_RPC_URL`; abra a transação no Explorer e confirme data/valor/destino; peça à OZAV o hash correto. Só marque entrega após verificação válida. |
| `ONCHAIN_CREDIT_DIFFERS_FROM_SETTLED` | Verificação: o crédito on-chain difere do valor líquido que a OZAV liquidou (ruling 30) | Divergência entre a chain e o relatório da OZAV. | A chain é a verdade. Registre as duas quantias, abra caso com a OZAV; não aprove entrega. Diferença pequena dentro da tolerância não basta se for diferente do líquido liquidado. |
| `TRAVEL_RULE_REQUIRED` (resposta definitiva da OZAV; erro `WITHDRAWAL_SEND_REFUSED` com `provider_code`) | O envio foi **recusado** definitivamente (400/401/403/422); o sistema nunca reenvia | A OZAV recusou antes de criar a transfer. Mas pode existir transfer mesmo assim. | **Ruling 28:** (1) o sistema faz uma busca somente-leitura por metadata; se achar transfer, alerta `withdrawal_refused_transfer_found` (alta) e **nada é vinculado ou reenviado**; (2) **confirme com a OZAV, por escrito, que nenhuma transfer existe** para esta operação; (3) só então um reenvio pode ser considerado — não há botão: é decisão manual, com apoio do desenvolvedor, e jamais com a mesma chave sem essa confirmação; (4) se não for possível enviar, siga a decisão de reembolso com a OZAV. Um 404 **não** é recusa definitiva: permanece `sending` e é recuperado por GET. |

Para qualquer `needs_review`, registre na revisão diária: operação, causa, quem foi contatado na OZAV, desfecho.

## 6. Alertas específicos — `/operador/alertas`

A tela lista os alertas operacionais (com link para Saques ou Estornos) e, abaixo, as **notificações por e-mail não
confirmadas** (`uncertain`: resultado incerto, nunca reenviado automaticamente; `failed`: não enviado), com o tipo, o
papel do destinatário (operador ou pessoa de confiança) e o código do erro, sem endereços nem conteúdo.

- **`pix_open_after_close` (alta):** a operação já está `failed`/`expired`, mas a transfer da OZAV continua pagável, foi paga ou
  concluída. A OZAV **não tem endpoint de cancelamento**; o dinheiro pode estar em custódia. Consulte a transfer; se
  houver pagamento, faça a decisão de reembolso (seção 4); se estiver apenas aberta, acompanhe até expirar e confirme que não foi paga.
  O alerta some quando existe decisão de reembolso.
- **`withdrawal_refused_transfer_found` (alta):** o envio foi dado como recusado, mas existe uma transfer na OZAV (achada por metadata, só GET).
  O dinheiro pode ter saído. Não reenvie, não vincule. Abra a transfer na OZAV, veja o estado e o `tx_hash`, e decida com a OZAV (verificar entrega
  manualmente ou reembolso). Registre na revisão diária.
- **`stuck_operation`** (e-mail "Operação parada"): `sending`/`sent` > 30 min, ou `awaiting_pix` após o prazo do Pix/trava. Reconcilie (**Saques → Detalhes → Conciliar**) antes de agir.
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
2. Abra o **Painel** (`/operador`): chaves, saques/estornos abertos e alertas de alta gravidade.
3. Revise o dia anterior (seção 2) e registre em **Revisão diária**.
4. **Alertas** — nada em aberto sem dono; nenhuma notificação `failed`/`uncertain` sem explicação (indicam problema no Resend).
5. **Saques** e **Estornos**; nenhum estorno com o prazo destacado em 12 h sem ação.
6. Mudou algo (chave, configuração)? Registre o motivo e o horário.

## Apêndice A — API direta (contingência)

Use somente se o console estiver indisponível. Autenticação: `Authorization: Bearer <JWT-do-operador-com-AAL2>`;
`API` é a origem HTTPS da API de produção. Gere um `request_id` UUID novo por intenção e guarde-o: depois de
`OPERATOR_MFA_STALE` ou de resultado incerto, repita com o **mesmo** `request_id`.

Chaves de runtime — ver e alterar (motivo de 1 a 500 caracteres; resposta traz `changed:true|false`):

```bash
curl -s "$API/v1/admin/runtime-controls" -H "Authorization: Bearer $OPERATOR_JWT"
curl -s -X PUT "$API/v1/admin/runtime-controls" \
  -H "Authorization: Bearer $OPERATOR_JWT" -H "Content-Type: application/json" \
  -d '{"key":"usdt_sends","enabled":false,"reason":"Pausa preventiva: motivo em uma frase"}'
```

Revisão diária (dia encerrado; `note` opcional até 500 caracteres):

```bash
curl -s -X POST "$API/v1/admin/daily-reviews" \
  -H "Authorization: Bearer $OPERATOR_JWT" -H "Content-Type: application/json" \
  -d '{"day":"2026-11-14","note":"Conciliação fechada; sem pendências"}'
```

Leituras: `GET /v1/admin/operational-alerts` (opcional `?severity=high`), `GET /v1/admin/operator-notifications`
(opcional `?status=uncertain|failed`; até 100, mais recentes primeiro), `GET /v1/admin/customer-reconciliation`,
`GET /v1/admin/withdrawal-requests?state=all`, `GET /v1/admin/withdrawal-requests/{id}/audit`,
`GET /v1/admin/refund-requests?state=pending_review|approved|rejected|refund_recorded|all`.

Aprovar e executar um envio (em testes a confirmação é `SANDBOX_ONLY`):

```bash
curl -s -X POST "$API/v1/admin/withdrawal-requests/$ID/approval" \
  -H "Authorization: Bearer $OPERATOR_JWT" -H "Content-Type: application/json" \
  -d '{"request_id":"<uuid-novo>","reason":"Conferido Pix, trava e carteira"}'
curl -s -X POST "$API/v1/admin/withdrawal-requests/$ID/execution" \
  -H "Authorization: Bearer $OPERATOR_JWT" -H "Content-Type: application/json" \
  -d '{"request_id":"<uuid-novo>","confirmation":"LIVE_USDT_SEND"}'
```

Execução: 201 = enviado; 200 = repetição idempotente; **202 = `recovery_required`** (não repita o POST com outra chave);
409 `EXECUTION_TOO_EARLY` traz `remaining_delay_seconds`. Acompanhar: `GET .../execution` e `POST .../execution/reconcile`
(sem corpo; reconciliação somente por GET na OZAV).

Reembolso — decisão sobre a operação e registro da conclusão:

```bash
curl -s -X POST "$API/v1/admin/operations/$PURCHASE_ID/refund-decision" \
  -H "Authorization: Bearer $OPERATOR_JWT" -H "Content-Type: application/json" \
  -d '{"request_id":"<uuid-novo>","reason":"Motivo do reembolso (10 a 500 caracteres)"}'
curl -s -X POST "$API/v1/admin/refund-requests/$REFUND_REQUEST_ID/completion" \
  -H "Authorization: Bearer $OPERATOR_JWT" -H "Content-Type: application/json" \
  -d '{"request_id":"<uuid-novo>","amount_brl":"1000.00","reference":"<referencia-da-OZAV>","confirmation":"MANUAL_REFUND_EXECUTED_EXTERNALLY"}'
```

Decisão de pedido do cliente (trilha legada): `POST /v1/admin/refund-requests/{id}/decision` com
`{"request_id":"<uuid-novo>","decision":"approved|rejected","reason":"...","confirmation":"MANUAL_REVIEW_COMPLETED"}`.
