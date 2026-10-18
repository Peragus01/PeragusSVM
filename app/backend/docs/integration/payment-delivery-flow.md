# Conversão e entrega de USDT — sequência confirmada pelo produto

Em 18/10/2026, Henrique informou ter confirmado diretamente com a equipe do parceiro: o USDT vai primeiro para a wallet do provedor e a API permite enviá-lo automaticamente, em seguida, à wallet de autocustódia do cliente. Esta nota registra a confirmação recebida, não uma operação real já executada nem uma prova dos parâmetros exatos da API.

O desenho de produto passa a considerar duas etapas explícitas:

1. Conversão/rampa e crédito na wallet do provedor, com identificação do cliente e conciliação da entrada.
2. Envio externo da wallet do provedor para o endereço de autocustódia do cliente, com identificação da saída e confirmação da transferência.

Cada etapa precisa de ID, chave idempotente quando suportada, status, tratamento de falha e reconciliação próprios. A falha/espera no envio externo pode deixar saldo na wallet do provedor e exige recuperação sem repetir a compra de USDT. Guardar a relação entre conversão, envio, rede/ativo e cliente; não declarar entregue ao cliente apenas porque a primeira etapa foi creditada.

Antes de execução: verificar no contrato/API o tipo de wallet e de custódia efetivamente provisionado para cada cliente, acesso da organização, ativo/rede suportados, origem dos recursos, vínculo do endereço destino e requisitos de Travel Rule. O relato não determina sozinho se o cadastro deve usar managed ou self_custody nem onde cada assinatura ocorre. Isso deve ser resolvido pela configuração real, sem transportar a decisão da fixture para live.

A carteira final de autocustódia pertence ao cliente; a chave privada dele não deve ser enviada à API Peragus. A confirmação do percurso acima não substitui o desenho de prova de posse e não comprova execução do programa Solana da Peragus nessa transferência.

Estado atual: sandbox, autenticação/perfis e fixtures validados; execução financeira continua bloqueada. Este documento não altera código, chaves ou flags. Uma transação real controlada só pode ser declarada concluída após validar as duas etapas e a confirmação final no destino.
