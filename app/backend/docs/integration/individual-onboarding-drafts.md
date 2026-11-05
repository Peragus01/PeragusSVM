# Rascunho PF protegido — primeira implementação

## Escopo

Implementa GET e PUT `/v1/me/onboarding/individual` para validar e salvar um cadastro brasileiro da própria conta PF. É uma etapa de staging, com **dados sintéticos apenas**, antes da apresentação/aceite dos termos e da criação de um cliente real. Não há chamada ao provedor, envio de documentos, vínculo de carteira, mudança de aprovação ou execução financeira. PJ permanece disponível no perfil mínimo e não pode usar esta rota PF.

O dono vem da sessão Supabase confirmada. Nome de exibição não vira nome legal. O rascunho não aceita e-mail: a identidade confirmada de Auth será a fonte quando o envio ao provedor for implementado. Rascunho e fixture do provedor são recursos separados; salvar um não cria, substitui ou promove o outro.

## Contrato frontend

Enviar bearer Authorization como nas outras rotas /v1. O proxy frontend precisa permitir este caminho e preservar Authorization. A resposta tem Cache-Control: no-store. Não guardar a resposta em analytics, cache compartilhado ou armazenamento persistente do navegador por padrão.

GET retorna `{data: null, meta: ...}` se não houver rascunho. Havendo dados, retorna `data: {individual, version, updated_at}` e meta com `environment: test`, `draft_only: true`, `operations_enabled: false`. Os campos de individual são devolvidos **em claro somente ao dono autenticado**, para retomar o formulário; não mostrar o CPF completo em tabelas/painéis sem necessidade. Não incluir corpos de requisição/resposta em logs do frontend.

PUT exige o objeto completo abaixo. `expected_version: 0` cria; para atualizar, usar a versão obtida no último GET/PUT. A atualização substitui o rascunho inteiro, não é um PATCH. Opcionais omitidos são removidos. Os valores são sintéticos ilustrativos e não devem ser usados como dados de uma pessoa real.

```json
{
  "expected_version": 0,
  "individual": {
    "legal_name": "Pessoa Sintetica Teste",
    "cpf": "529.982.247-25",
    "date_of_birth": "1990-01-01",
    "nationality": "BR",
    "phone": { "country_code": "55", "number": "11999999999" },
    "residential_address": {
      "line1": "Rua de Teste", "number": "1", "neighborhood": "Bairro Teste",
      "city": "Cidade Teste", "state": "SP", "postal_code": "01001-000", "country": "BR"
    },
    "source_of_funds": "Dados sinteticos",
    "monthly_income_usd": 0,
    "expected_monthly_volume_usd": 10
  }
}
```

Regras locais:

- CPF com 11 dígitos ou máscara convencional; verifica dígitos e rejeita sequências repetidas. Normaliza para dígitos. Não comprova existência/titularidade e não garante que um CPF de teste esteja desatribuído.
- Nome legal de 2–160 caracteres após trim. Não inferir de display_name.
- Nascimento: data de calendário real, idade de 18 a 120 anos, calculada pela data em America/Sao_Paulo.
- Nacionalidade: duas letras maiúsculas. Este marco valida o formato, não confere todas as atribuições de códigos ISO.
- Telefone: código de discagem de 1–4 dígitos, iniciando sem zero, normalizado com +; número nacional de 5–20 dígitos; no máximo 20 dígitos somando as duas partes. Não confirma titularidade nem alcance do número.
- Endereço brasileiro: logradouro, número, bairro, cidade, UF válida, CEP de oito dígitos (máscara opcional) e país BR. CEP é normalizado sem hífen. Não há consulta de endereço ou comprovação documental.
- Origem de recursos: texto obrigatório, até 160 caracteres. Não defaultar declaração.
- Renda e volume esperado são números JSON finitos, não negativos, em **USD**. Zero é válido. Limite de formulário deste MVP: 1 bilhão; não é um limite do provedor nem autorização de operação. Não converter BRL implicitamente nem aceitar string monetária.
- Complemento, ocupação e finalidade são opcionais (até 160 caracteres). is_pep é booleano opcional, não recebe false por ausência.
- Objetos estritos: não aceitar IDs, owner, e-mail, ambiente, status, custódia, aprovação ou flags adicionais. Máximo 16 KiB por requisição. Erros não ecoam CPF ou o valor inválido.

Primeira gravação retorna 201, atualizações 200. Meta inclui `provider_submitted: false`. Cada sucesso aumenta a versão. Dois envios com a mesma versão não se sobrescrevem: um recebe 409 DRAFT_VERSION_CONFLICT. Após resposta incerta, fazer GET e reconciliar antes de repetir; não mudar expected_version às cegas. Um replay do PUT original pode receber conflito mesmo que o conteúdo seja igual, porque a pré-condição já foi consumida.

| HTTP/código | Significado |
| --- | --- |
| 401 AUTH_REQUIRED / INVALID_TOKEN | Autenticar |
| 403 EMAIL_NOT_CONFIRMED / CUSTOMER_REQUIRED / CUSTOMER_SUSPENDED | Gate de conta existente |
| 403 INDIVIDUAL_PROFILE_REQUIRED | Rota exclusiva PF ativa |
| 400 VALIDATION_ERROR | Corrigir campos indicados; a resposta contém caminhos, não valores |
| 409 DRAFT_VERSION_CONFLICT | Recarregar a versão e resolver edição concorrente |
| 503 CUSTOMER_ONBOARDING_DISABLED | Recurso desligado |
| 503 INDIVIDUAL_DRAFT_UNAVAILABLE | Falha de leitura, chave, integridade ou armazenamento; nenhuma aprovação é inferida |

## Criptografia e banco

Migration 015 cria `peragus_individual_onboarding_drafts`, uma linha por cliente, environment fixo test, versão, datas e encrypted_payload. Não armazena CPF, endereço, telefone, renda ou nome legal em colunas abertas. RLS habilitada e grants anon/authenticated revogados. Os perfis mínimos continuam em sua própria tabela e não recebem dados legais por este marco.

A aplicação usa AES-256-GCM, nonce aleatório de 12 bytes e tag de autenticação de 16 bytes. O envelope contém schema 1, key_id, nonce, tag e ciphertext em base64. O AAD inclui finalidade, ambiente, customer_id, versão do rascunho, schema e key_id. Copiar ciphertext para outra conta ou versão, adulterar o envelope ou usar outra chave falha na autenticação. Nenhum hash de CPF é usado como proteção.

A chave simétrica canônica de 32 bytes em base64 fica em `CUSTOMER_DATA_ENCRYPTION_KEY`, somente na API staging; identificador não secreto em `CUSTOMER_DATA_ENCRYPTION_KEY_ID` (padrão v1). O banco não recebe a chave. Isso protege o conteúdo em dumps/acesso ao banco; um processo autorizado que possui a chave consegue decifrar. Não é uma garantia contra comprometimento da própria API ou do ambiente que guarda sua chave.

Não há rotação automática/keyring nesta entrega. Conservar a chave correspondente aos dados, inclusive para recuperação de backup, separada dos backups de banco e do repositório. Se a chave se perder, restaurar a chave original; gerar uma nova não recupera os rascunhos. Troca coordenada e recriptografia exigirão implementação própria. Leitura ou atualização de um rascunho ilegível falha sem sobrescrevê-lo silenciosamente.

O parser privado da rota lê bytes e traduz JSON malformado em erro fixo, evitando mensagens de parser que ecoem trechos do corpo sensível. A rota registra apenas um evento fixo de indisponibilidade, sem exceção/payload. Backend não deve habilitar logs globais de corpos.

## Rollout de staging

1. Build e testes da branch; aplicar migration 015 com o procedimento guardado, mantendo os flags financeiros false.
2. Merge para develop e deploy API com `CUSTOMER_ONBOARDING_ENABLED=false` (padrão). A chave pode ficar ausente enquanto desligado. Nenhuma variável nova no worker.
3. Para aceite controlado, gerar uma chave aleatória localmente e guardá-la em Railway como CUSTOMER_DATA_ENCRYPTION_KEY. Não compartilhar no chat/PR, nem substituir chave existente. Manter o ID estável e ativar CUSTOMER_ONBOARDING_ENABLED somente na API staging. Startup exige banco/Auth de staging fixos, chave válida e bloqueios financeiros existentes.
4. Com PF de teste, GET inicialmente null, PUT de dados sintéticos retorna 201 versão 1, GET retoma, PUT esperado 1 retorna versão 2; repetir versão antiga retorna 409. Outra PF não lê/edita; PJ, conta suspensa e anônimo são bloqueados. Conferir ciphertext no banco sem copiar chave/dados para logs.
5. Aprovação local continua draft, operações false e nenhum cliente novo no provedor. Desligar o flag após aceite; preservar chave e rascunhos para recuperação.

Antes de coleta real: termos/privacidade, proteção/retenção/exclusão operacional, revisão de acesso e fronteira live, jornada frontend e a integração de termos/verificação precisam ser concluídos. Esta implementação não oferece endpoint de submissão nem comprova KYC.
