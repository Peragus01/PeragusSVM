# Submissão do cadastro PF — sandbox

## Escopo e separação de identidade

Implementa GET `/v1/me/onboarding`, POST `/v1/me/onboarding/submit` e POST `/v1/me/onboarding/refresh` para a própria PF. Usa o rascunho cifrado e uma sessão de termos do parceiro já aceita. Não recebe CPF, e-mail, token secreto, status, IDs externos ou parâmetros de custódia do navegador nessa chamada. O dono vem do Supabase Auth confirmado; perfis suspensos/PJ ficam bloqueados.

Este é **um cadastro sintético do fluxo de formulário**, não uma identidade real em produção. O frontend/operador precisa afirmar sandbox_data_confirmed:true e usar somente dados sintéticos. O código não pode determinar se uma pessoa digitou acidentalmente um CPF real. O e-mail enviado é gerado no servidor como `peragus-onboarding-test-<customer UUID>@example.com`, evitando enviar o e-mail real de login ao sandbox. O futuro fluxo live precisará do e-mail confirmado, termos próprios da Peragus e regras de coleta/privacidade antes de receber dados reais.

O novo vínculo fica em peragus_customer_onboarding_submissions, separado de peragus_ozav_sandbox_customer_links. A fixture antiga não é promovida, reutilizada ou apagada. Criar o novo vínculo não altera o perfil local, não declara KYC concluído e não habilita pagamentos, mesmo se o provedor responder approved. Não cria uma sessão de verificação nem encaminha documentos. As verificações reais e o envio de USDT continuam fora deste marco.

## Contrato de API

Todas as rotas exigem Authorization bearer e retornam Cache-Control: no-store. O proxy do frontend precisa permitir os novos caminhos. A nova flag default-off CUSTOMER_SUBMISSION_ENABLED configura somente a API de staging. Pode permanecer ativa com CUSTOMER_ONBOARDING_ENABLED, CUSTOMER_TERMS_ENABLED e OZAV_SANDBOX_CUSTOMERS_ENABLED desativadas: os serviços internos podem ler os dados cifrados sem reabrir os endpoints anteriores. A chave cifrante/ID existentes são reutilizados; não gerar outra chave nem mudar o worker. Webhooks e flags financeiras preservam sua configuração.

### GET /v1/me/onboarding

Retorna data:null antes da reserva. Depois retorna apenas metadados:

```json
{
  "data": {
    "submission_id": "UUID-local",
    "environment": "test",
    "sandbox_submission": true,
    "state": "linked",
    "draft_version": 1,
    "terms_session_id": "UUID-local-dos-termos",
    "provider_customer_id": "ozav_cus_...",
    "provider_status": "pending",
    "verification_mode": "full",
    "provider_snapshot": null,
    "refreshed_at": null,
    "operations_enabled": false
  },
  "meta": { "operations_enabled": false }
}
```

Não retorna conteúdo do rascunho, token de termos, payload, HMAC, chave idempotente, renda ou identidade em claro. pending significa intenção sem vínculo local concluído, não que a operação externa certamente falhou. linked significa vínculo cadastral persistido, não cliente apto a movimentar dinheiro.

### POST /v1/me/onboarding/submit

```json
{
  "draft_version": 1,
  "terms_session_id": "UUID-local-da-sessao-aceita",
  "sandbox_data_confirmed": true
}
```

Na primeira intenção, o backend lê o rascunho atual e confere a versão solicitada. Resolve internamente a sessão de termos da mesma conta: precisa estar ativa, accepted e não expirada. Abre token/evidência cifrados e confere o nome legal do rascunho e o timestamp da evidência. Não aceita autoaprovação ou token escolhido pelo browser. Um nome alterado depois do aceite exige resolução/novo aceite coerente; não reaproveitar evidência de outro nome. A renovação/alteração de nome antes do vencimento não ganha um bypass neste marco.

A solicitação ao provedor contém type individual, individual com CPF em tax_id BR/cpf e demais dados normalizados, token de termos, verification_mode full, custody_model managed e monitoring false. A escolha managed é explícita **apenas para este teste**, coerente com os produtos já consultados; não presume o modelo de custódia live nem comprova posse de carteira. external_ref determinístico é `peragus-onboarding-test:<customer UUID>`; não é tratado como uma chave única/prova de propriedade fornecida pelo usuário.

Retorno 201 após vínculo persistido; 200/Idempotency-Replayed:true para a repetição de vínculo já concluído. O ID do cliente precisa ter formato correto, refletir email/external_ref esperados e retornar modo full; resposta reliance ou sem postura full não é aceita como sucesso. Um ID já usado por uma fixture é recusado; o mesmo ID não pode ser vinculado a duas submissões locais.

### POST /v1/me/onboarding/refresh

Corpo `{}`. Busca o cliente atual no provedor usando o vínculo do servidor, valida a correlação e grava snapshot sanitizado/data. Não aceita um ID externo no JSON. O snapshot separa status/verification_mode/status de verificação dos códigos e contagens de exigências pendentes. Ausência de requisitos não é tratada como aprovação. Não modifica autorização financeira.

Depois da primeira submissão, usar refresh para a primeira observação completa. Um webhook pode chegar antes de o vínculo estar persistido e ser ignorado como não vinculado; a atualização explícita fecha essa janela. GET é somente observação em cache.

## Intenção cifrada, idempotência e recuperação

Migration 017 cria peragus_customer_onboarding_submissions, somente environment test, uma intenção por cliente, com referência local aos termos, versão do rascunho, estado, vínculo externo, snapshot/versionamento e envelope cifrado do pedido. RLS e revogação de grants anon/authenticated protegem o acesso pelo browser.

O pedido completo, incluindo o token de termos, é congelado/cifrado antes do POST externo. AES-256-GCM usa nonce aleatório, tag autenticada e AAD com namespace peragus-registration, ambiente, schema, key ID, ID da intenção, dono, versão do rascunho e sessão de termos. O HMAC de consistência usa subchave derivada por HKDF, com domínio separado; não é hash simples de CPF. A chave permanece fora do banco e segue a mesma política de conservação/backup das etapas anteriores.

Retries de uma intenção pending abrem e verificam o pedido congelado e usam exatamente o mesmo payload e Idempotency-Key. Não releem um rascunho editado nem trocam o token por uma sessão renovada. Isso também vale quando os termos originais expiraram após a primeira tentativa: serve para reconciliar/repetir a operação original, não autoriza começar um novo cadastro com termos vencidos.

Um timeout, resposta 202, conflito externo ou falha local deixa a intenção pending. O cliente deve consultar o estado e repetir de forma limitada, sem trocar versão/termos/chave. A retenção idempotente externa é limitada pelo provedor: não fazer retries indefinidos. Se uma resposta permanecer incerta, reconciliar com o parceiro por procedimento operacional antes de tomar outra ação. Não adotar um cliente de erro 409, por e-mail ou por external_ref.

Este marco não oferece reset automático de intenção ou correção de payload já enviado. Uma recusa que exija dados corrigidos, duplicidade, termos inválidos ou expiração precisa de investigação/reconciliação; não apagar a linha e criar outra chave. Uma segunda intenção conflitante é recusada. Editar o rascunho depois do envio não altera automaticamente o cliente do provedor.

Um vínculo concluído é repetido localmente, sem novo POST externo. Corridas de conclusão não substituem um snapshot mais recente por status antigo da resposta de criação. Não há funder, publisher de settlement ou job financeiro nesta classe.

## Webhooks

O receiver já ativo passa a procurar vínculos em ambas as tabelas de teste. Um ID precisa corresponder a um único vínculo; se houver ambiguidade entre fixture e submissão, o evento é recusado. Vínculo novo atualiza somente sua própria tabela. Permanecem assinatura em bytes originais, janela de tempo, ambiente explícito, dedupe por evento/hash, nova consulta ao provedor e commit atômico de snapshot/recibo.

A consulta de vínculo de submissão não precisa abrir CPF/token cifrados; a correlação esperada é derivada do customer_id local. Assim o webhook continua operacional sem ativar os endpoints de edição/termos/submissão. Um resultado processed continua sem aprovar o perfil ou liberar operações.

**Migration 017 é necessária antes do deploy mesmo com a nova flag false**, porque o webhook ativo passa a consultar a tabela nova. Seguir o procedimento guardado antes do merge.

## Erros

| HTTP/código | Significado |
| --- | --- |
| 401/403 dos gates existentes | Autenticar/confirmar e-mail/usar PF ativa |
| 503 CUSTOMER_SUBMISSION_DISABLED | Nova funcionalidade desligada |
| 400 VALIDATION_ERROR | Versão, ID local, declaração de dados sintéticos ou campos adicionais inválidos |
| 409 ONBOARDING_DRAFT_REQUIRED | Falta rascunho válido e legível |
| 409 ONBOARDING_DRAFT_CHANGED | Versão do formulário mudou antes da primeira intenção |
| 409 de termos | Sessão alheia, inativa, não aceita, expirada ou evidência incompatível |
| 409 ONBOARDING_CONFLICT | Não trocar dono/pedido/termos/ID ou sobrescrever vínculo/snapshot |
| 409 ONBOARDING_CAPABILITY_REQUIRED | Ambiente/entitlement/escopo inadequados; não usar chave live |
| 409 ONBOARDING_NOT_SUBMITTED | Refresh sem vínculo concluído |
| 502 ONBOARDING_PROVIDER_UNAVAILABLE | provider_http_status e retryable sanitizados; automatic_linking false |
| 503 CUSTOMER_SUBMISSION_UNAVAILABLE | Chave, integridade ou persistência local indisponível; não apagar intenção |

Respostas e logs não incluem erro bruto do provedor ou JSON de dados pessoais. O parser privado limita corpo a 8 KiB e não ecoa fragmentos inválidos.

## Rollout e critérios de aceite

1. Build/testes da branch e migration 017 no staging com destino/SSL guardados e flags financeiras false. Não enviar payloads pela máquina de desenvolvimento antes do deploy.
2. Merge develop, deploy API com CUSTOMER_SUBMISSION_ENABLED=false (padrão). Preservar os webhooks ativos e a chave cifrante existente.
3. Ativar somente CUSTOMER_SUBMISSION_ENABLED na API staging. Manter edição do rascunho, criação/aceite de termos e fixture manual desligados. Conferir customer_submission_configured enabled:true.
4. Usar conta PF de teste, versão 1 do rascunho sintético e sessão aceita ainda válida. Se expirou, usar a jornada explícita de renovação/aceite antes da primeira submissão, sem inventar aceite.
5. POST submit retorna 201 linked e ID diferente da fixture anterior. Repetir retorna 200, mesmo ID e replay true. GET não expõe dados/token. SQL confirma envelopes e vínculo; não imprimir o payload decifrado.
6. POST refresh retorna snapshot sanitizado; um customer.updated real do novo ID deve atualizar a mesma submissão, com recibo processed, sem alterar fixture ou aprovação local. Testar acesso de outra conta e bloqueio financeiro.
7. Desativar CUSTOMER_SUBMISSION_ENABLED após aceite. Webhook permanece ligado enquanto o endpoint externo estiver ativo. Preservar chave, histórico e intenções.

Testes locais cobrem transporte real com mocks, dados de rascunho/termos cifrados, POST/replay, timeout e edição posterior, falha de persistência, duplicidade, modo incorreto, fixture ID, isolamento, campos proibidos, confirmação explícita de sandbox, RLS e atualização/rollback pelo processador de webhook. Entrega externa e comportamento de cadastro completo do provedor ainda exigem staging. KYC simulado, documentos, disponibilidade live, termos próprios da Peragus, revisão de custódia e execução financeira continuam pendentes.
