# Verificação de identidade PF — sandbox

## Escopo e pré-condições

Inicia/retoma e acompanha uma verificação para o cliente do **cadastro de formulário**, não a fixture antiga. Só PF própria, autenticada, confirmada e não suspensa. É necessário um vínculo linked em peragus_customer_onboarding_submissions. O início consulta a postura atual do cliente no provedor e exige full; não converte reliance em full nem atesta que a Peragus já verificou a pessoa.

As capacidades fixas deste teste são kyc_document, liveness, face_match e aml_name_screening. Essa escolha de teste não é uma afirmação sobre o conjunto juridicamente suficiente para KYC live. Nenhum documento, selfie ou dado biométrico é coletado/armazenado por este marco. Nome/CPF/token de termos não precisam ser abertos para consultar este vínculo.

A chave de teste nunca retorna session_url na documentação. O parser rejeita uma URL recebida inesperadamente em sandbox; a resposta Peragus sempre tem session_url:null e sandbox_only:true. Não inventar um link de captura nem colocar o cliente num loop de criação procurando um link. Captura live e seus requisitos de disponibilidade continuam fora deste código.

## Configuração e migração

- CUSTOMER_VERIFICATIONS_ENABLED=false por padrão: leitura/início/refresh da verificação.
- CUSTOMER_VERIFICATION_SIMULATION_ENABLED=false por padrão: POST de simulação. Requer o flag anterior; habilitá-lo isoladamente impede a inicialização.
- Ambos somente no PeragusSVM staging, não no worker. Mantêm banco/Auth fixos no staging, test key e todas as flags financeiras false.
- A chave existente precisa de customers:read, verifications:read e verifications:write, mais entitlements customers e compliance para iniciar/simular. Refresh exige apenas os escopos de leitura. Não trocar por chave live para contornar permissões.
- Não precisa gerar chave de cifragem nem reativar edição de rascunho, termos ou submissão. Os dados pessoais existentes permanecem cifrados nas tabelas anteriores.
- Startup registra customer_verification_configured com enabled e simulation_enabled, sem segredos.

Migration 018 cria peragus_customer_verifications, com dono relacionado à submissão, ambiente fixo test, ID do cliente/da verificação, marcador de tentativa de criação, observação sanitizada, revisão e datas. RLS e grants de browser revogados; IDs externos únicos. Aplicar no staging pelo runner guardado antes do merge.

## Contrato de API

Todos os caminhos exigem Authorization bearer, perfil PF próprio e retornam Cache-Control:no-store. Corpos de até 8 KiB são processados sem ecoar trechos de JSON malformado. IDs de provedor/checks/redirect_url não são recebidos do browser. O proxy frontend deve permitir os novos caminhos e preservar Authorization.

### GET /v1/me/onboarding/verification

Retorna data:null antes da reserva, ou a observação local:

```json
{
  "data": {
    "provider_customer_id": "ozav_cus_...",
    "verification_id": "ozav_vrf_...",
    "state": "linked",
    "status": "pending",
    "checks": { "kyc_document": "not_started", "liveness": "not_started", "face_match": "not_started", "aml_name_screening": "not_started" },
    "observed_outcome": null,
    "refreshed_at": "2026-10-19T00:00:00.000Z",
    "last_simulated_outcome": null,
    "environment": "test",
    "sandbox_only": true,
    "session_url": null,
    "operations_enabled": false
  }
}
```

Antes de vincular o ID, state é creating, status/data de atualização nulos e checks vazio. GET é cache, não polling do provedor. Os quatro checks contêm apenas os valores conhecidos pass/fail/review/pending/not_started. O parser descarta motivos, documentos, dados extras e respostas completas. Um check ausente continua ausente, não vira pass ou not_started inventado.

observed_outcome só é approved quando status é completed e todos os quatro checks estão pass; é rejected quando completed tem pelo menos um fail; nos demais casos é null. review e ausência de dados nunca são silenciosamente aprovados. É uma interpretação operacional **simulada**, não uma aprovação local/financeira nem evidência de captura real.

### POST /v1/me/onboarding/verification

Corpo `{}`. Inicia ou retoma a sessão da conta. 201 quando o POST externo foi executado/concluído nesta chamada; 200 quando já vinculada/recuperada por lookup. meta.idempotent_replay informa a retomada, não uma garantia de idempotency header do provedor.

A API externa não documenta Idempotency-Key neste POST. Por isso não a enviamos nem presumimos que será respeitada:

1. Reservar a intenção local com o ID do cliente do vínculo.
2. Consultar GET /verifications filtrado para esse cliente, validando cada resultado. O cliente interno percorre no máximo dez páginas de cem; paginação incompleta, repetida ou inválida impede criar/adotar um resultado.
3. Se houver uma única sessão recuperável com os quatro checks e dono correto, confirmar via GET individual e vinculá-la. Não escolher silenciosamente entre várias sessões ou usar ID vindo de erro/caller.
4. Se não houver sessão e nenhum POST foi tentado, marcar atomicamente create_attempted antes do envio. Só um concorrente recebe o direito de enviar.
5. Se a resposta se perder ou a gravação falhar, repetir o início faz lookup, **sem outro POST**. Um 409 do provedor também é reconciliado por lookup. Se nada recuperável aparecer, retornar VERIFICATION_RECOVERY_REQUIRED e investigar; não apagar o marcador nem criar sessões cegamente.

Esse desenho privilegia evitar segunda criação/cobrança sobre disponibilidade automática. Um processo que caia entre a marcação e o envio pode exigir recuperação operacional mesmo sem ter criado sessão. Não há reset/restart ou recuperação automática de sessão expirada nesta entrega. Uma sessão antiga recuperada é retomada com seu estado; isso não promete uma nova verificação.

### POST /v1/me/onboarding/verification/refresh

Corpo `{}`. Consulta a verificação vinculada, confere ID/dono e salva os checks/status. Em seguida atualiza o snapshot do cliente cadastral. Não cria sessão. A revisão da observação impede sobrescrita de uma gravação concorrente.

### POST /v1/me/onboarding/verification/simulate

Somente com os dois flags explicitamente ativos:

```json
{ "outcome": "rejected" }
```

Ou approved. Não aceita reason livre, ID externo, checks ou status arbitrários. O backend consulta a sessão atual antes da ação. Se já está no resultado desejado, não repete o POST externo; caso contrário usa o helper exclusivo sandbox. Só grava sucesso se a resposta observada corresponde ao resultado solicitado. Falhas preservam possibilidade de consultar/reconciliar; nunca inferir sucesso por ter enviado o POST.

A observação da verificação e o snapshot cadastral são recursos separados, atualizados sequencialmente. Se a primeira gravação passou e a atualização do cliente falhou, a chamada pode retornar erro com a verificação já atualizada; repetir refresh/simulação começa por leitura atual, sem necessidade de criar outra sessão. O webhook customer.updated existente continua atualizando o cliente cadastral; este marco **não** adiciona subscription/processamento de verification.updated. Para os checks, usar refresh explícito. Evitar polling curto e simulações concorrentes/opostas.

O helper pode criar projeções de wallets/contas no sandbox do parceiro. Essas projeções não são contas bancárias abertas nem endereços on-chain provisionados. Não fazem transferência, não financiam wallets e não executam o programa Solana. last_simulated_outcome registra o último resultado solicitado/conferido pelo teste; o estado atual continua sendo observation/checks e precisa de refresh quando houver alteração externa.

## Erros e barreiras

| HTTP/código | Ação |
| --- | --- |
| 401/403 dos gates existentes | Autenticar/confirmar e-mail/usar PF ativa |
| 503 CUSTOMER_VERIFICATIONS_DISABLED | Funcionalidade desligada |
| 503 VERIFICATION_SIMULATION_DISABLED | Simulação não habilitada |
| 400 VALIDATION_ERROR | Usar corpo vazio ou outcome permitido, sem IDs/checks |
| 409 VERIFICATION_CUSTOMER_REQUIRED | Falta cliente do formulário linked |
| 409 VERIFICATION_FULL_MODE_REQUIRED | Postura atual não é full; não usar fallback reliance |
| 409 VERIFICATION_CAPABILITY_REQUIRED | Corrigir escopos/produtos de sandbox |
| 409 VERIFICATION_PROCESSING | Outra chamada já reclamou a criação; consultar/recuperar |
| 409 VERIFICATION_RECOVERY_REQUIRED | Resultado incerto, lista ambígua ou incompatível; reconciliar sem novo POST |
| 409 VERIFICATION_NOT_STARTED | Falta sessão vinculada para refresh/simular |
| 409 VERIFICATION_CONFLICT | Vínculo, ID ou revisão não corresponde |
| 409 VERIFICATION_OUTCOME_MISMATCH | Resposta não comprova o resultado simulado solicitado |
| 502 VERIFICATION_PROVIDER_UNAVAILABLE | HTTP/retryable sanitizados, sem dados brutos |
| 503 CUSTOMER_VERIFICATION_UNAVAILABLE | Persistência/falha local; ler estado antes de repetir |

Em nenhuma resposta/update há concessão de operações. peragus_customers.verification_status permanece draft. A eventual autorização financeira futura precisará de política própria e consulta atual, além de KYC verdadeiro, termos Peragus, custódia, limites e demais requisitos; estes flags de simulação nunca servirão como aprovação de produção.

## Rollout e aceite

1. Build/testes da branch e migration 018 no staging com os guardas existentes. Merge develop e deploy com ambos os flags false.
2. Ativar CUSTOMER_VERIFICATIONS_ENABLED=true na API e manter simulação false. Não alterar worker, chaves, webhooks ou flags financeiras. Conferir o log de configuração.
3. Com PF de teste e novo vínculo cadastral, POST início retorna sessão própria pending/sem URL (ou recupera uma já existente). Repetir mantém ID sem segunda criação. GET deve ler cache, refresh busca o estado atual. Registrar ausência de URL como esperado para sandbox.
4. Ativar temporariamente CUSTOMER_VERIFICATION_SIMULATION_ENABLED=true. Testar rejected e approved, um por vez, observando checks e snapshot cadastral. Repetir resultado já observado não deve refazer o POST externo. Conferir que o perfil local continua draft e operações false.
5. Desativar primeiro simulação e depois verificação ao encerrar, ou desligar ambos no mesmo deploy. Preservar o webhook ativo e os registros de auditoria. Nenhum dado real deve ser enviado ao sandbox.

Os testes usam respostas simuladas e banco PostgreSQL embutido: cobrem transporte/parsing, criação/retomada, recuperação de timeout/falha local/409, ausência de resultado recuperável, simulação/falha local, checks desconhecidos, ambiguidade, identidade/URL incorretas, escopos, concorrência de revisão, isolamento, bloqueios e RLS. Entrega externa e comportamento real do helper continuam pendentes de aceite no staging. Não declarar KYC real ou prontidão live a partir desses testes.
