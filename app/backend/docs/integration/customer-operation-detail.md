# Consulta direta de operação própria

`GET /v1/me/operations/:id`, com Bearer Supabase do cliente PF e `Cache-Control: no-store`.

`:id` é o UUID local da intenção de compra, o mesmo `id` retornado pelo histórico. Não é o UUID do Pix nem da retirada. Não aceita parâmetros de consulta, seletores de cliente, cursor ou limit.

Resposta 200: `{ "data": <mesma projeção de uma operação do histórico> }`.

Inclui os valores BRL/USDT registrados, estimativa separada do valor convertido, estado do Pix, retirada e caminho de resultado, além do marcador do pedido de estorno quando existir. Não inclui motivo interno do operador, identificadores privados do provedor, observações brutas, dados KYC ou provas criptográficas da carteira. Valores líquidos/taxas continuam sendo consultados no endpoint de resultado da retirada; não se presumem a partir do bruto.

A consulta filtra a operação pelo UUID e cliente autenticado diretamente no banco, sem percorrer páginas ou consultar OZAV. Todas as junções continuam vinculadas ao mesmo cliente e ambiente test. Não movimenta dinheiro, não atualiza o provedor, não cria jobs e não altera registros. Funciona com as flags de escrita desabilitadas.

- Sem autenticação: 401.
- Perfil ausente/PJ/suspenso: 403, conforme o acesso já usado pelo histórico.
- UUID ou query inválidos: 400 `VALIDATION_ERROR`.
- Operação inexistente ou pertencente a outro cliente: mesma resposta 404 `OPERATION_NOT_FOUND`.
- Serviço/DB indisponível: 503 `OPERATION_HISTORY_UNAVAILABLE`, sem mensagem privada da infraestrutura.

Nenhuma migration, variável de ambiente ou alteração no frontend é necessária para publicar esta rota. O backend deve manter a migration 028 já aplicada, dependência existente do histórico e dos estornos.

## Staging

Após testes e deploy com flags financeiras e manuais desligadas, usar a conta dona da operação `d2c92755-774f-4e3d-af74-0205fe440f94` para comparar a resposta ao item do histórico. Esperado: BRL 1000.00, USDT convertido 198.050000, retirada provider_completed, estorno approved. Não inferir devolução realizada ou entrega on-chain.

Repetir a leitura com outro cliente: 404 `OPERATION_NOT_FOUND`. Tentar query `customer_id`, `cursor`, `limit` e UUID inválido: 400. Nenhuma dessas verificações solicita uma transferência.

## Integração futura do frontend

O responsável pelo portal pode substituir o percurso limitado de páginas em `/app/operacoes/$id` por esta consulta direta. O proxy/frontend atual não é alterado neste PR: sua allowlist precisará autorizar somente GET no caminho exato, mantendo bearer e no-store. As rotas de estorno e resultado da retirada permanecem independentes.
