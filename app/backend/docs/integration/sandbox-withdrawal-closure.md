# Encerramento auditado do piloto de retirada sandbox

O slot global antes permanecia ocupado mesmo após completed. Esta etapa permite arquivar uma execução concluída, liberando capacidade para uma operação distinta. A execução antiga e suas chaves continuam únicas. Não é cancelamento, estorno, nova aprovação ou prova de entrega on-chain.

Aplicar migration033 antes do deploy. SANDBOX_WITHDRAWAL_CLOSURE_ENABLED=false por padrão. Para aceitação, habilitar só esta flag na API staging com chave ozav_sk_test, banco/Auth staging fixados, operador allowlisted e MFA. Flags de execução de retirada e outras movimentações permanecem false; API_RATE_LIMITS_ENABLED continua true. Worker não executa encerramento.

GET e POST /v1/admin/withdrawal-requests/:id/execution/closure. UUID é da solicitação de retirada. GET lê a auditoria, inclusive com flagfalse, e404 se não existir. POST estrito até4KiB:

```json
{"request_id":"UUID_ESTAVEL","reason":"Motivo de encerramento sandbox com pelo menos dez caracteres.","confirmation":"CLOSE_COMPLETED_SANDBOX_PILOT"}
```

Requer operador separado de cliente e MFA verificado, inclusive para GET. Queries e campos extras são400; autenticação401, permissões403, inexistente404, pré-requisitos/conflitos409, flagfalse ou falha de leitura/banco503. Respostas no-store e limites de escrita existentes. Falhas não expõem erros da OZAV, tokens, CPF ou carteira.

Para primeiro encerramento: execução test com criação tentada, provider_send_id vinculado e observação local completed em ambos legs. O serviço recebe apenas a capacidade GET transfer e valida novamente na OZAV os vínculos de cliente/carteira/transferência, moeda/rede/destino e valor bruto. Estado e ambos legs da nova leitura devem ser completed. Não depende de saldo atual nem presume taxa ou valor líquido. Divergência, timeout, estado incerto/pendente/falha ou mudança local concorrente mantém a vaga ocupada.

Uma instrução transacional confere o snapshot local sob lock, atualiza closed_at e insere auditoria append-only com ator/MFA, motivo, chave, valor e snapshots local/recente. Constraint trigger diferido exige auditoria correspondente; execução encerrada não pode ser modificada, apagada ou reaberta. O GET expõe somente metadados administrativos e valor bruto, sem snapshots internos.

201 na primeira gravação; replay exato200 sem outra consulta externa. Alterar motivo/recurso sob a mesma chave409; outro pedido para uma execução já encerrada409. Falha ambígua de resposta: repetir mesma chave, nunca inventar nova execução. unique(withdrawal_request_id), unique(approval_id) e chave de envio continuam presentes. Repetir execução antiga com a chave original apenas lê o resultado; outra chave é bloqueada. Nova operação exige todo o fluxo de compra, funding e aprovação próprios. Fechar piloto não os habilita automaticamente.

executionView agora informa pilot_slot_held=false e pilot_closed_at. Histórico de compra/resultado permanece provider_completed; estorno aprovado continua aprovado e sem conclusão. Recuperação de execução já encerrada lê o snapshot arquivado, sem GET/UPDATE adicionais. A fila de reconciliação não reenviará nada.

Limitação intencional: só encerramos completed consistente. Pilotos falhos, incertos e reservados exigem investigação; não há liberação genérica nem SQL manual para apagar a trava. Freshness aqui significa consulta realizada antes do commit local, não atomicidade com a OZAV. O ambiente é sandbox, real_money=false e onchain_delivery_verified=false.

Depois de validar encerramento/leitura/replay/isolamento em staging, desligar SANDBOX_WITHDRAWAL_CLOSURE_ENABLED na API e worker. A vaga permanece livre; a evidência antiga permanece imutável.
