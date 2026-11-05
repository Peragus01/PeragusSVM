# Reconciliação automática de compras sandbox

O worker passa a acompanhar Pix e retiradas já solicitados. A função não cria cobrança, não simula pagamento, não cria/aprova solicitação de retirada e não envia dinheiro. Reaproveita a validação e persistência das rotas de recuperação existentes. Não usa identidade fictícia de operador: a tarefa interna recebe somente capacidades GET; os endpoints administrativos continuam exigindo allowlist e MFA.

## Configuração e implantação

Aplicar `029_add_customer_reconciliation.sql` no staging antes do merge/deploy. A migration cria checkpoints, histórico imutável de tentativas e uma chave composta de integridade. Não altera dinheiro, saldos, pedidos ou claims de envio existentes.

`CUSTOMER_RECONCILIATION_ENABLED=false` por padrão. Para aceitar no staging, habilitar **somente no peragus-worker**. A API pode permanecer com a flag em false: sua consulta de status é somente leitura.

O worker habilitado exige o banco de staging fixado pelo guard existente, DATABASE_SSL=true, chave ozav_sk_test_* e as flags financeiras/demo desabilitadas. Manter também as flags de execução de retirada, simulação e estorno desligadas durante esta aceitação. A chave usada pelo leitor nunca é exposta em logs ou nas respostas.

A fila separada `customer-sandbox-reconciliation` recebe um tick por minuto, com consumidor único, retry de job desabilitado e uma observação por tick. Registros de até 100 Pix e 100 retiradas já tentados são descobertos em cada tick sem gerar novas solicitações financeiras. Reservas que ainda não tentaram o pedido não entram na reconciliação.

Os retries são **somente de leitura do provedor**, controlados por checkpoint com intervalo mínimo de um minuto, lease de dez minutos e token de posse. O leitor faz chamadas com timeout de 10s e listagens limitadas a 20 páginas; um item não extrapola a lease em condições normais. Se o processo morrer, a lease expira e outro worker retoma as leituras. A atualização do checkpoint verifica o token; um worker antigo não sobrescreve o resultado do novo.

Desligar a flag e concluir o redeploy remove o agendamento e deixa de registrar o consumidor. Uma leitura já em andamento pode terminar durante o encerramento; ela não envia dinheiro. As rotas de consulta continuam funcionando e os checkpoints não são apagados.

## Estados e revisão

- `pending`: o resultado ainda não é terminal; haverá nova consulta.
- `provider_terminal`: a observação terminou no provedor. Não significa entrega on-chain, finalização financeira real ou reembolso.
- `needs_review`: evidência divergente, recurso local ausente, falha que requer intervenção ou limite de tentativas atingido. A tarefa não reinicia nenhuma transferência.

Um resultado `completed` com legs incompletos vai para revisão, sem afirmar sucesso. Pix expirado/não pago encerra o polling; se o source leg já estiver pago, exige análise manual dos fundos. Retiradas failed/cancelled/expired/needs_review exigem revisão.

Pedidos ainda pendentes após 15 minutos são marcados `manual_review_required` e continuam as leituras até o limite de 120 tentativas. Após esse limite, param em needs_review. Esses sinais aparecem nos logs e na consulta administrativa; entrega de alerta por e-mail/SMS não está incluída. Uma lista vazia da OZAV preserva a incerteza; nunca prova ausência da transferência e nunca limpa a claim.

Cada resultado persistido grava um evento imutável com status, tentativa, sinal de revisão e código de erro sanitizado. Claims de Pix, simulação e retirada, aprovações, saldos e o pilot slot não são alterados. Não há endpoint de reset/reenvio.

## Consulta administrativa

`GET /v1/admin/customer-reconciliation?state=all&limit=20`

- Bearer de operador separado de cliente, allowlist existente, MFA aal2.
- state: all, pending, provider_terminal, needs_review. limit de 1 a 50.
- Sem customer_id, cursor ou outros seletores. O endpoint fornece uma janela operacional limitada, não um export completo do histórico.
- Resposta `{data:[...],meta:{environment:"test",provider_reads_only:true,financial_retries:false}}`, Cache-Control: no-store.
- Exibe IDs locais, tentativas, último status/erro seguro, datas e indicação de lease. Não retorna credenciais, IDs privados do provedor, informações KYC, observações brutas ou referência de transação.
- Perfil de cliente: 403. Operador sem MFA: 403. Query inválida: 400. DB indisponível: 503 sanitizado.

Não há alteração no frontend ou no seu proxy. O novo endpoint é usado diretamente pela API no teste WSL.

## Aceitação

1. Build e testes, incluindo migration, Pix/retirada, recuperação de binding, incerteza, evidência divergente, lease abandonada, fencing, limite de tentativas e MFA.
2. Aplicar migration 029 no staging; merge/deploy com a flag false nos dois serviços.
3. Habilitar somente o worker. Após alguns ticks, ler a consulta administrativa com MFA. Os registros sandbox existentes devem avançar no checkpoint conforme a observação da OZAV, sem executar novas cobranças/retiradas.
4. Conferir a operação conhecida e os saldos apenas por leitura; nenhuma nova transferência pode surgir. Conferir bloqueio de cliente/operador sem MFA.
5. Desabilitar a flag após o teste controlado, preservando status e histórico.

Orquestração de criação das etapas, convites e entrega Mainnet não são implementados por este módulo. A tarefa conclui a parte de acompanhamento automático de registros existentes, sem misturar polling e autorização financeira.
