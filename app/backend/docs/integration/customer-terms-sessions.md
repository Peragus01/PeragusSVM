# Sessões de termos PF — implementação de staging

## Escopo

GET/POST `/v1/me/onboarding/terms` e POST `/v1/me/onboarding/terms/accept` implementam a apresentação de uma sessão de termos e o registro **explícito** do aceite. Apenas PF própria, autenticada com e-mail confirmado e não suspensa. PJ fica no perfil mínimo existente. Este marco não cria cliente no provedor, não inicia KYC, não vincula carteira e não libera operações.

Usar somente o ambiente test e dados sintéticos no rascunho PF. O provedor simula exigências de termos no sandbox; um aceite bem-sucedido aqui não comprova que o gate de provisioning live foi validado. A ação explícita e a evidência local ainda são exigidas pela nossa API para exercitar a jornada correta.

## Configuração

Flag nova `CUSTOMER_TERMS_ENABLED=false` por padrão, somente no PeragusSVM staging. Quando ativa, reutiliza **a chave já existente** CUSTOMER_DATA_ENCRYPTION_KEY e seu ID para proteger token/evidência com outro namespace e finalidade autenticados. Não gerar ou substituir a chave do cadastro PF. Também requer o test API key existente, entitlement customers e customers:write. Os guardas fixam banco/Auth de staging e mantêm as flags financeiras desativadas.

CUSTOMER_ONBOARDING_ENABLED pode permanecer false: o serviço de termos consegue ler internamente o rascunho já salvo sem reabrir o formulário GET/PUT. Nenhuma variável nova no worker. CUSTOMER_WEBHOOKS_ENABLED permanece independente e ativo para o endpoint já registrado. Startup registra customer_terms_configured com booleano, sem segredos.

Migration 016 cria peragus_customer_terms_sessions. Aplicar no staging antes do merge/deploy, com o runner guardado usado nas migrations anteriores. A tabela mantém histórico, ambiente fixo test, uma sessão ativa por cliente, estados, lease, geração, chave idempotente, URL/versão/expiração, envelopes cifrados e data do aceite. RLS e revogação de grants de browser continuam em vigor.

## Contrato frontend

Todos os caminhos exigem Authorization bearer e retornam Cache-Control: no-store. O proxy precisa permitir os caminhos e preservar cabeçalhos de autorização/retry. Limite de corpo 8 KiB; o parser privado evita ecoar JSON sensível em mensagens de erro. Não armazenar sessão/aceite em analytics ou cache persistente do browser.

### GET /v1/me/onboarding/terms

Retorna `data: null` se não houver sessão ativa; caso contrário:

```json
{
  "data": {
    "session_id": "UUID-local-opaco",
    "state": "ready",
    "terms_url": "https://ozav.io/terms",
    "terms_version": "2.0",
    "expires_at": "2026-10-19T00:00:00.000Z",
    "expired": false,
    "accepted_at": null,
    "can_accept": true,
    "can_renew": false,
    "environment": "test",
    "operations_enabled": false
  }
}
```

`session_id` é o ID local, não o token ts_. Nenhuma resposta contém token, nome legal, e-mail ou evidência em claro. O backend valida a integridade do contexto cifrado antes de devolver os metadados de uma sessão pronta.

### POST /v1/me/onboarding/terms

Corpo `{}` cria uma intenção e solicita a sessão, ou retoma a sessão pronta ainda válida. Retorna 201 na criação concluída e 200 ao retomar; não registra aceite. Criações incertas não disparam uma sequência automática de novos tokens.

O frontend apresenta terms_url e terms_version antes de oferecer uma ação de aceite, sem caixa pré-selecionada. O cliente real do provedor só aceita URL HTTPS na origem exata https://ozav.io, sem credenciais, query, fragmento ou token ts_ no caminho. Mudanças legítimas dessa origem/formato exigirão revisão explícita, não fallback a uma URL recebida do usuário.

### POST /v1/me/onboarding/terms/accept

```json
{ "session_id": "UUID-local-recebido", "accepted": true }
```

A chamada deve ocorrer **somente após o usuário visualizar os termos e declarar o aceite**, não ao login, ao criar a sessão ou por um job automático. No teste manual, abrir a URL e tomar essa decisão antes de executar o comando de aceite; não confundir o teste com consentimento de um cliente real.

O backend exige rascunho PF salvo e legível. Congela o nome legal daquele rascunho e o horário UTC da primeira tentativa de aceite. Não aceita accepted_by, accepted_at, token, IP, user-agent ou IDs de outra pessoa no JSON. Campos adicionais são rejeitados. O e-mail de login não é enviado ao provedor nesta etapa de sandbox. Não fabricamos IP ou user-agent; coleta confiável da origem via proxy e o desenho de evidência live ainda precisam ser concluídos.

Retorna 200 com state accepted quando o provedor confirma a mesma URL, versão, expiração e data de aceite. Uma repetição já concluída retorna o mesmo estado local sem repetir o POST externo. A aprovação PF e o vínculo com o cliente fictício não são alterados. A aceitação não é um endpoint de aprovação ou de pagamento.

## Respostas incertas e expiração

O provedor entrega o token da sessão apenas uma vez. Mesmo um replay idempotente de criação não retorna o token. Por isso:

1. A intenção local e a chave idempotente são persistidas antes do POST. A geração local impede que uma tentativa antiga sobrescreva uma nova.
2. Uma lease de 30 segundos bloqueia chamadas concorrentes. O cliente externo faz uma tentativa com timeout de 5 segundos por chamada; não segura transação de banco durante HTTP.
3. Após timeout/falha local, GET pode mostrar creating. Aguardar Retry-After antes de repetir o mesmo POST. A retomada reaproveita a mesma chave; não pressupõe que o token será recuperado.
4. Um replay sem token muda o estado para uncertain e retorna TERMS_RECOVERY_REQUIRED. Não tentar adivinhar o token, apagar registros ou trocar chaves manualmente.
5. GET informa o session_id ativo e can_renew. Para uma sessão uncertain ou expirada que não esteja aceitando, a renovação é uma ação explícita: POST no mesmo caminho com `{ "renew_session_id": "UUID-local-atual" }`. O backend desativa a sessão anterior e reserva uma nova, preservando o histórico. Não renova uma sessão pronta válida só porque o usuário recarregou a tela.

No aceite, a evidência cifrada é persistida **antes** do POST externo. Se a resposta ou a gravação final se perder, o estado fica accepting. Depois da lease, o retry usa o mesmo token e exatamente o nome/data originais, mesmo que o rascunho tenha sido editado. O provedor declara esse aceite idempotente. Resposta contraditória não vira accepted localmente; requer investigação/recuperação. Uma sessão accepting não pode ser substituída por renovação enquanto o resultado está incerto.

Sessão ready expirada não pode receber novo aceite. Um aceite já concluído pode continuar visível como accepted com expired true; este marco não afirma que tal sessão satisfaz uma futura criação live. O provisioning terá de conferir as regras vigentes do provedor.

## Criptografia e evidência

Token e evidência usam AES-256-GCM com nonces aleatórios de 12 bytes e tags de 16 bytes, com finalidades distintas token/acceptance. O AAD inclui namespace peragus-terms, ambiente test, schema, key ID, dono, ID local da sessão, URL/versão/expiração. Alterar/cross-copiar envelopes ou metadados faz a autenticação falhar. Rotação de chaves permanece não implementada; preservar a chave e o backup seguro já definidos no contrato de rascunhos.

O token ts_ fica somente no envelope do servidor e nos POSTs diretos ao provedor. Não entra em URL, log ou resposta ao frontend. Evidência também não é gravada em claro. URL/versão/expiração e timestamp final são metadados abertos para apresentação/auditoria. Os logs de falha são fixos e não contêm corpo, exceção nem resposta bruta do provedor.

Estado local accepted significa que nosso serviço recebeu uma confirmação compatível com a evidência enviada. Não é prova isolada de identidade ou de que a pessoa leu todo o documento, e não substitui a implementação da interação frontend ou da governança de consentimento para dados reais.

## Erros e ações

| HTTP/código | Ação |
| --- | --- |
| 401/403 dos gates existentes | Autenticar/confirmar e-mail/usar PF ativa |
| 503 CUSTOMER_TERMS_DISABLED | Recurso desligado |
| 400 VALIDATION_ERROR | Corrigir JSON; não acrescentar identidade/timestamps |
| 404 TERMS_SESSION_NOT_FOUND | Sessão inexistente ou alheia, sem revelar o dono |
| 409 TERMS_PROCESSING | Aguardar Retry-After: 30, depois ler/retomar |
| 409 TERMS_SESSION_EXPIRED | Ler sessão atual e oferecer renovação explícita |
| 409 TERMS_RECOVERY_REQUIRED | Ler can_renew e oferecer nova sessão controlada |
| 409 TERMS_SESSION_CONFLICT | Recarregar estado; evitar ação sobre sessão antiga |
| 409 TERMS_PROFILE_REQUIRED | Completar rascunho PF antes de aceitar |
| 409 TERMS_CAPABILITY_REQUIRED | Corrigir configuração de sandbox/escopos, sem usar live |
| 409 TERMS_RESPONSE_CONFLICT | Não inferir aceite; investigar resposta incompatível |
| 503 CUSTOMER_TERMS_PROVIDER_UNAVAILABLE | Ver provider_http_status/retryable seguros; não expõe corpo do provedor |
| 503 CUSTOMER_TERMS_UNAVAILABLE | Falha local/chave/integridade; não sobrescrever nem apagar evidências |

## Aceite de staging e próximos passos

Build/testes e migration 016; merge develop e deploy inicialmente com flag false. Em seguida ativar apenas CUSTOMER_TERMS_ENABLED na API usando a chave cifrante já existente. GET inicial null; POST cria ready com ID local e link; repetir cria 200 com mesmo ID. Abrir termos antes de declarar aceite. POST accepted true registra accepted; replay e GET preservam a mesma data sem vazamento do token. Conferir no SQL somente estado/versão/metadados e presença de envelopes, sem imprimir conteúdo. Preservar bloqueios financeiros e não enviar dados reais ao sandbox.

Os testes locais cobrem transportes e URLs, token protegido por contexto/finalidade, replay, evidência congelada após falha de banco, perda do token, renovação, expiração, capacidade, resposta contraditória, perfis/isolamento e RLS. Ainda precisam de validação as respostas externas reais de criação/aceite. Testes PGlite serializam sua conexão; concorrência real do pool é parte da aceitação operacional.

A próxima etapa é um vínculo cadastral separado e uma submissão full idempotente, consumindo internamente a sessão aceita. Não promover a fixture, não expor o token para facilitar a integração e não ativar operações financeiras nesta fase.
