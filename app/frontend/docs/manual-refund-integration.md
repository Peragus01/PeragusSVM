# Estornos manuais no portal do PR #31

Esta integração parte de `feat/frontend-mvp-integration` (PR #31) e usa sua sessão em memória, componentes `customer-ui`, layout dark e rotas TanStack. Backend necessário: PR #32, com migration 028 já aplicada no staging. Nenhuma nova migration ou variável pública é necessária.

## Rotas e autorização

- `/app/operacoes/$id`: mantém o detalhe existente. Acrescenta consulta do pedido e formulário com motivo. O ID continua sendo o da intenção de compra; não é o ID da retirada. Consultas e envio usam `/api/v1/me/operations/:id/refund-request`.
- `/app/operacoes`: exibe o estado de estorno informado pelo histórico.
- `/operador/estornos`: nova tela separada, com login pela mesma sessão Supabase, conta sem perfil de cliente e verificação TOTP. Backend continua responsável por allowlist, separação de contas e MFA `aal2`. A fila é paginada; análise permite aprovar/rejeitar com motivo interno e confirmação explícita de conferência.
- `/login`: link para a área do operador. Não cria outra identidade nem armazena tokens.

O proxy aceita somente GET/POST do pedido do cliente, GET da fila/detalhe administrativo e POST da decisão. **Não expõe completion, execução de retirada, reconciliação ou outros endpoints administrativos.** POST exige bearer explícito, JSON até 4 KiB; nenhum cookie é encaminhado. Respostas têm `Cache-Control: no-store` e `Vary: Authorization`. Não há retry automático, redirect externo ou persistência dos tokens.

Uma tentativa com resultado incerto mantém chave e corpo iguais enquanto o formulário permanece montado. Ao reabrir, a consulta busca o registro salvo; a unicidade no backend continua impedindo um segundo pedido/decisão para a mesma operação. Trocar conta ou operação desmonta o estado anterior e cancela requisições pendentes.

## Significado dos estados

- `pending_review`: em análise.
- `approved`: análise aprovada, devolução pendente.
- `rejected`: pedido não aprovado.
- `refund_recorded`: devolução registrada manualmente. Exibe o valor retornado informado, inclusive parcial, sem afirmar verificação pelo provedor.

Aprovação não movimenta dinheiro, não cancela a retirada original e não registra uma devolução. O contexto de retirada iniciada exige conferência manual dos fundos. O formulário de conclusão externa não faz parte desta tela; mantém-se o procedimento manual já definido no backend.

## Validação local e staging

1. Instalar com `npm ci --ignore-scripts --no-audit --no-fund`.
2. Executar `npm run build`, `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=1`. Build regenera `routeTree.gen.ts` incluindo a rota do operador.
3. Configurar os valores públicos `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` do mesmo staging e o endereço server-only `PERAGUS_BACKEND_URL`. Nunca copiar credenciais privadas do backend para variáveis VITE.
4. Manter `MANUAL_REFUNDS_ENABLED=false` e todas as flags financeiras desabilitadas. Entrar com o cliente original, abrir a operação de teste e conferir o estado aprovado sem valor devolvido. Trocar de conta e verificar que não aparece a operação alheia.
5. Entrar em `/operador/estornos` com a conta separada de operador; confirmar TOTP e conferir a fila. A conta de cliente deve ser bloqueada. Com a flag desabilitada, decisões são recusadas pelo backend.
6. Testes de criação/decisão no staging exigem habilitar somente a flag manual na API, de forma controlada, e desabilitar ao terminar. Nenhuma chave de produção é necessária.

Os testes locais usam respostas sintéticas e verificam evidência financeira, privacidade, limites do proxy, repetição idempotente, MFA e estados das telas. Não substituem validação de login/MFA real e responsividade do preview com as contas de staging.

## Ordem de integração

Este PR tem como base a branch do PR #31, ainda aberto. Integre estas alterações nessa branch antes de concluir o PR #31 para `develop`; evita duas implementações concorrentes do portal. Nenhum merge automático é feito.
