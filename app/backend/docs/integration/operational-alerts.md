# Fila de alertas operacionais — leitura sandbox

GET /v1/admin/operational-alerts requer bearer validado, operador allowlisted separado de cliente e MFA aal2. Cache-Control:no-store e limites de leitura da API existentes. Funciona com flags de escrita/reconciliação desligadas. Sem migration ou nova flag.

Filtros estritos: kind (all, reconciliation_review, reconciliation_stalled, withdrawal_uncertain, withdrawal_review, refund_pending_review, refund_approved), severity (all/high/medium), limit (1–50, padrão20), cursor (next_cursor da página anterior). Qualquer selector adicional, cursor inválido ou corpo é rejeitado com400. Falta de MFA/allowlist retorna403, falta de serviço ou erro de banco retorna503 OPERATIONAL_ALERTS_UNAVAILABLE sem detalhes internos.

Alta prioridade: checkpoint marcado para revisão; polling pendente atrasado pelo menos15min sem lease ativa; retirada com criação tentada sem observação; retirada falha/cancelada/expirada/needs_review ou completed sem ambos os legs completed. Não infere falha financeira de polling atrasado. Retirada completed com ambos legs completed não é alerta por si só, mesmo sem prova on-chain: sandbox não comprova entrega real.

Prioridade média: estorno sem decisão ou aprovado sem conclusão externa registrada. Aprovação não significa devolução nem autorização automática. Pedidos rejeitados e devoluções já registradas não aparecem como pendências. O mesmo purchase pode ter alertas de tipos diferentes; IDs tipo:UUID distinguem as evidências.

Ordenação por prioridade e depois registro mais antigo, UUID e tipo, com cursor preservando microssegundos. first_recorded_at é criação do registro de origem, não o instante em que passou a gerar alerta. Fila derivada de dados mutáveis: resoluções desaparecem e novos alertas podem entrar antes do cursor; recarregar desde a primeira página para uma visão atual. Não é uma fotografia imutável nem histórico de notificações.

Resposta expõe somente IDs locais, tipo, severidade, timestamp e detail_path para as rotas administrativas já existentes. Não retorna email, CPF, carteira, motivo interno, identificadores ou payloads do provedor, tokens ou códigos de convite. meta.provider_refreshed=false e meta.notifications_sent=false. Sem envio de email/SMS, confirmação de leitura, fechamento manual ou notificações push nesta versão. Monitoramento exige operador consultar a fila; não substitui alertas externos para indisponibilidade total da API.

Uma consulta SELECT/UNION ALL, sem escrita ou chamada externa. Não cria aprovação, execução, devolução, job, retry financeiro ou alteração da trava de retirada. Alertas indicam análise necessária, nunca instrução para repetir um envio. Reconciliação usa somente as rotas GET-only já aprovadas, sob suas próprias permissões e flags.

Aceitação staging: operador com MFA deve localizar o estorno conhecido aprovado e sem conclusão; cliente recebe403 e sessão de operador sem MFA recebe403. Validar filtros, paginação/no-store e preservação da operação. Sem flags financeiras habilitadas e sem nova transferência.
