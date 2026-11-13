# Transação interna de R$ 1.000 — passo a passo e Go/No-Go

A primeira transação real da Peragus: **R$ 1.000 em Pix → USDT na Solana Mainnet**, feita por uma **segunda pessoa física de
confiança** (CPF, KYC e carteira próprios; decisão D6), que também recebe os alertas. **Operador ≠ cliente, sem exceção**:
a conta de operador nunca é a conta do cliente (o sistema recusa com `OPERATOR_ACCOUNT_SEPARATION_REQUIRED`).

Este é dinheiro real. Em qualquer dúvida: **pare e pause** (`operator-runbook.md` seção 1). Parar nunca custa dinheiro; seguir às cegas, sim.
Para cada etapa, colete a evidência indicada e guarde-a em uma pasta privada (nunca no repositório): IDs, hashes, capturas sem segredos.

## Pré-requisitos (todos devem estar verdadeiros antes do passo 1)

- [ ] `configuration-checklist.md` conferido para produção, item a item (Railway API/workers, Vercel, Supabase, OZAV, GitHub).
- [ ] Staging verde: CI e smoke ponta a ponta concluídos.
- [ ] Produção implantada com **todas as chaves de runtime desligadas** (`new_operations`, `usdt_sends`, `onboarding`); boot sem erro;
      logs com `money_environment_verified` (`money_mode: live`, `network: solana:mainnet`, `ozav_probed: true`); `/ready` retorna 200.
- [ ] Capabilities live da OZAV registradas (`GET /v2/capabilities` com a chave live): on-ramp BRL→USDT/Solana, custódia, envio externo,
      Travel Rule, facility de trava, `session_url` de KYC, webhooks. Respostas escritas da OZAV arquivadas (facility contratado, KYC hospedado,
      devolução de Pix somente manual, taxa de rede descontada, criação da ATA).
- [ ] Endpoint de webhook registrado na OZAV de produção (`/webhooks/customer-updates`) e `CUSTOMER_WEBHOOK_SECRET` conferido.
- [ ] MFA do operador funcionando em produção (login → TOTP → `GET /v1/admin/runtime-controls` 200); `operator-mfa-reset.md` lido.
- [ ] Pessoa de confiança confirma que **recebe** o e-mail de teste de alerta (mude uma chave e volte; veja o e-mail).
- [ ] Reserva de reembolso de pelo menos R$ 1.000 disponível na conta Peragus (reembolso é manual, via OZAV).
- [ ] Backup externo feito e **restauração testada** (`backup-and-restore.md`); `main` protegida; monitor de uptime em `/health` e `/ready`.
- [ ] A pessoa de confiança tem convite e **ATA do USDT** na carteira Mainnet (ou a OZAV confirmou que cria a ATA).
- [ ] Limites: `PURCHASE_MIN_BRL=1000.00`, `PURCHASE_MAX_BRL=1000.00`, `PURCHASE_MAX_OPEN_GLOBAL=1` — exposição máxima R$ 1.000.

## Passo a passo

### Passo 1 — Abrir o cadastro (`onboarding`)

1. Ligue **somente** `onboarding`: `PUT /v1/admin/runtime-controls` `{"key":"onboarding","enabled":true,"reason":"Transação interna: cadastro da pessoa de confiança"}`.
2. Emita o convite para a pessoa de confiança (console `operador.convites`). Ela cria a conta pelo link, confirma o e-mail e **aceita Termos e Privacidade**
   (a política de reembolso fica visível); ela conclui o cadastro de pessoa física com dados reais e inicia o KYC hospedado da OZAV.
3. Ela vincula a carteira Mainnet com prova de assinatura.

Evidência: e-mail de convite e de confirmação (capturas), linha do aceite jurídico (versões e hashes), resultado do KYC (aprovado, verificação da OZAV),
carteira verificada (endereço público), capturas da tela do cliente. Critérios Go/No-Go: 2, 3, 4, 5, 6.

### Passo 2 — Abrir novas operações (`new_operations`)

1. Confirme que **não há revisão diária pendente** (se já houve atividade em dia anterior, revise-o primeiro; seção 2 do runbook do operador).
2. Ligue `new_operations`. A pessoa de confiança pede cotação de R$ 1.000, confere a **trava de câmbio** e **aceita** (USDT travado, carteira de destino imutável).
3. Gere o Pix e **pague R$ 1.000 reais** da conta bancária **da própria pessoa de confiança**. O Pix só aparece com a trava verificada; sem trava aceita não existe Pix.
4. Aguarde o reconhecimento: webhook → GET da transfer 1 `completed` → operação `awaiting_approval`.

Evidência: ID da cotação, ID da transfer 1 (OZAV), valor travado em USDT, comprovante do Pix, evento do webhook e o GET (logs sem segredos), capturas da tela.
Critérios: 7, 8. **NO-GO imediato** se o valor pago/travado divergir (`LOCKED_AMOUNT_MISMATCH`), `needs_review` ou qualquer alerta de alta severidade.

### Passo 3 — Aprovar e executar o envio (`usdt_sends`)

1. Ligue `usdt_sends` (a aprovação não depende dela; a execução sim).
2. Operador revisa a trilha (`/audit`), aprova com TOTP fresco; a pessoa de confiança recebe o e-mail de **aprovação**.
3. Espere o intervalo mínimo (**15 min**); tentar antes devolve `EXECUTION_TOO_EARLY`. Refaça o TOTP e **execute** com `confirmation: "LIVE_USDT_SEND"`.
   A pessoa de confiança recebe o e-mail de **execução**. Verifique o bloqueio de ATA (`DESTINATION_TOKEN_ACCOUNT_MISSING`/`_FROZEN`) antes de insistir.
4. Acompanhe `sending → sent → delivered_verified`. **Um único POST** de envio: confirme nos logs da API que só existe um `peragus-send-<id>`
   e nenhuma repetição. Em resposta 202 (`recovery_required`) **não repita** o POST; use a reconciliação.
5. Confirme a entrega `finalized` no Solana Explorer (cluster `mainnet-beta`): mint `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB`, destinatário = carteira verificada,
   valor entre (travado − 0,10 USDT) e travado e igual ao líquido da OZAV; o cliente vê status real e o link do Explorer.

Evidência: IDs das transfers 1 e 2, `tx_hash`, link do Explorer e captura, e-mails de aprovação/execução recebidos pela pessoa de confiança, trecho de log provando um POST,
tela do cliente. Critérios: 9, 10, 11, 13. **NO-GO** se: segundo POST, `needs_review` (`TX_ALREADY_USED`, `TX_PREDATES_SEND`, `ONCHAIN_CREDIT_DIFFERS_FROM_SETTLED`, `MINT_MISMATCH`,
`RECIPIENT_MISMATCH`, `AMOUNT_MISMATCH`), entrega não `finalized`, valor/destinatário errados.

### Passo 4 — Conciliação, kill switches e fechamento

1. Feche a conciliação: **BRL pago ↔ transfer 1 ↔ transfer 2 ↔ on-chain** (`GET /v1/admin/customer-reconciliation`); sem divergência nem alerta.
2. **Teste dos kill switches** (critério 14): pause e retome cada chave sem perda de operação — ex.: desligue `usdt_sends` e confirme `OPERATIONS_PAUSED`
   (nenhuma operação em andamento é cancelada), religue; idem `new_operations` e `onboarding`. Cada mudança gera auditoria e e-mail à pessoa de confiança.
3. No **dia seguinte** (o dia só pode ser revisado depois de encerrado), registre a **revisão diária** da conciliação.
4. Desligue `new_operations` e `usdt_sends` ao concluir o ensaio, salvo decisão do Go/No-Go.
5. Confirme que nenhum recurso de staging foi usado pela produção (checagens de boot e logs; critério 15).

Evidência: reconciliação (resposta), eventos de auditoria das chaves e e-mails correspondentes, linha da revisão diária, logs de boot.
Critérios: 12, 14, 15.

## Checklist Go/No-Go (16 critérios — todos com evidência arquivada)

GO para clientes externos **somente** com todos marcados:

- [ ] 1. Capabilities live registradas e respostas da OZAV arquivadas.
- [ ] 2. Conta criada por convite com e-mail confirmado.
- [ ] 3. Aceite jurídico gravado no backend com versão e hash.
- [ ] 4. Login, sessão e MFA do operador funcionando em produção.
- [ ] 5. KYC aprovado pela sessão hospedada da OZAV.
- [ ] 6. Carteira verificada com prova de assinatura de Mainnet.
- [ ] 7. Cotação com câmbio travado, aceita.
- [ ] 8. Pix real reconhecido pelo GET da OZAV.
- [ ] 9. Aprovação e execução com MFA renovado, intervalo respeitado e alerta recebido pela pessoa de confiança.
- [ ] 10. USDT enviado uma única vez, sem POST duplicado nos logs.
- [ ] 11. Entrega `finalized` na Mainnet com mint, destinatário e valor conferidos.
- [ ] 12. Conciliação BRL ↔ transfer 1 ↔ transfer 2 ↔ on-chain fechada.
- [ ] 13. Cliente vê o status real e o link do Explorer.
- [ ] 14. Kill switches testados (pausar e retomar sem perda de operação).
- [ ] 15. Nenhum recurso de staging usado pela produção (checagens de boot e logs).
- [ ] 16. Backup externo com restauração testada; `main` protegida.

Registre a revisão de Go/No-Go (data, responsável, decisão, itens, riscos aceitos: minutas jurídicas não revisadas — D7; operador único — D4).

## NO-GO — pare e não abra para clientes externos se ocorrer qualquer um

- Qualquer critério acima sem evidência, ou evidência ambígua.
- Qualquer bloqueador financeiro ou de segurança em aberto.
- Chave `ozav_sk_test_` em produção, RPC devnet/mint não canônico, `PERAGUS_DEPLOYMENT_ENV` ausente, flags de simulação ligadas, ou o boot recusando a configuração.
- Capabilities live sem on-ramp BRL→USDT/Solana, facility de trava, envio externo ou Travel Rule; KYC hospedado indisponível.
- Mais de um POST de envio, `needs_review` não explicado, `pix_open_after_close` ou `withdrawal_refused_transfer_found` em aberto.
- Entrega fora de `finalized`, mint ou destinatário diferentes, valor fora da tolerância ou diferente do líquido da OZAV.
- Conciliação com divergência; webhook com assinatura inválida sem explicação.
- E-mail de alerta **não** recebido pela pessoa de confiança; falha no teste de pausar/retomar; restauração de backup não testada.
- Qualquer sinal de comprometimento da conta do operador (siga `operator-mfa-reset.md` e pause tudo).

Se o NO-GO ocorrer com dinheiro já movido: pause (`new_operations` e `usdt_sends`), **não reenvie nada**, consulte a OZAV pelas transfers 1 e 2
(somente leitura), e use a decisão de reembolso do `operator-runbook.md` (seção 4) — a pessoa de confiança é reembolsada pelo mesmo caminho manual e dentro das 24 h.
