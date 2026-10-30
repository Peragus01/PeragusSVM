# Cotação e intenção sandbox

For the current functional onboarding/purchase journey, see [invited-customer-journey.md](invited-customer-journey.md). This document records the preceding milestone.

A tela `/app/comprar-usdt` consulta uma cotação indicativa e permite registrar uma intenção separada. Não gera Pix, não simula pagamentos e não solicita retiradas. A estimativa não representa valor líquido ou entrega em Solana.

As únicas rotas adicionadas ao proxy são POST `/v1/me/quotes`, POST `/v1/me/purchase-intents` e GET dos respectivos registros por UUID. O navegador envia cookies apenas à origem Vercel; o proxy encaminha somente o bearer à API, com cache desativado e sem seguir redirecionamentos.

Os identificadores e o valor são salvos em sessionStorage por cliente, antes do POST. Não são salvos tokens, senhas ou respostas completas. Após recarregar a página é necessário autenticar novamente; a consulta exige ação explícita. Resultados incertos conservam a mesma chave, sem repetição automática. Fechar a aba remove essa continuidade; consulte o histórico antes de iniciar outra intenção. O backend continua responsável pela autorização e pela idempotência.

O formulário remove a antiga referência de R$ 500 e aceita o mínimo atual de R$ 1.000. O backend ainda impõe seu limite de R$ 10.000; a UI não altera esse contrato. Custos de entrega e valor líquido permanecem não informados.

## Validação no Preview

1. Fazer merge desta alteração em `feat/frontend-mvp-integration` e criar um Preview dessa branch com suas variáveis de staging.
2. Na API de staging, habilitar somente `CUSTOMER_QUOTES_ENABLED=true` e `CUSTOMER_PURCHASE_INTENTS_ENABLED=true` para este teste. Manter ambas false no worker e manter flags de Pix, simulação, retiradas e execução desligadas.
3. Entrar com o cliente de sandbox elegível, informar `1000,00` e consultar a cotação. Conferir origem, estimativa e referências; não presumir o resultado de cotações anteriores.
4. Registrar a intenção e conferir o mesmo ID no histórico. Reconsultar com a mesma referência após uma falha não deve criar outro registro.
5. Desligar as duas flags na API ao concluir. As rotas GET continuam disponíveis para registros existentes.

Verificação local: `npm run typecheck`, `npm test -- --maxWorkers=1` e `npm run build`.
