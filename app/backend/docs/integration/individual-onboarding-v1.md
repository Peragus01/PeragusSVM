# Cadastro PF e encaminhamento para verificação — contrato proposto v1

**Estado: desenho técnico para implementação.** Este documento não adiciona endpoints, não habilita chave live, não coleta dados pessoais e não libera operações. É a referência de trabalho entre backend e frontend para a próxima etapa. Fonte: OpenAPI fornecido pelo parceiro, lido em 18/10/2026; detalhes operacionais ainda precisam de validação de integração.

## 1. O que já existe e o que permanece separado

Implementado: autenticação Supabase por e-mail/senha, confirmação de e-mail, perfil mínimo PF/PJ, isolamento por cliente, registros não executáveis, vínculo PF fictício em sandbox, consulta explícita e atualização por webhook do status/pêndencias desse vínculo. Ver customer-auth-v1.md, ozav-sandbox-customer.md e customer-webhooks.md.

A tabela `peragus_ozav_sandbox_customer_links` contém **fixtures**, não identidades legais. Não converter o cliente fictício em pessoa real, não substituir seu CPF por CPF real e não reutilizar seu ID para live. O webhook atual só reconhece esses vínculos de teste. Um novo cadastro real precisará de vínculo próprio por cliente, provedor e ambiente; o webhook terá de ser estendido explicitamente para esse modelo. Os testes anteriores não validaram KYC real.

O nome de exibição do perfil não comprova nome legal. Conectar uma carteira não comprova identidade civil nem autentica uma conta Peragus. O frontend continua responsável pela experiência de autenticação e pela apresentação do formulário; o backend deriva o dono e o e-mail confirmado do token verificado.

## 2. Dados para PF brasileira

O contrato de criação externo aceita cadastro incompleto; os campos abaixo representam a coleta proposta para avançar o cadastro brasileiro, sem confundir HTTP 201 com cadastro completo. As pendências atuais do cliente continuam sendo a referência para complementação.

| Dado | Origem/entrada Peragus proposta | Campo externo | Tratamento |
| --- | --- | --- | --- |
| Nome legal completo | Cliente | `individual.legal_name` | Não usar automaticamente display_name |
| E-mail confirmado | Supabase Auth, no servidor | `email` | Não aceitar e-mail de outra pessoa no corpo |
| CPF | Cliente | `individual.tax_id` com country BR, type cpf, value | Validar formato e dígitos; validação matemática não comprova titularidade |
| Data de nascimento | Cliente, data YYYY-MM-DD | `individual.date_of_birth` | Data real, sem futuro, faixa documentada de 18 a 120 anos |
| Nacionalidade | Cliente | `individual.nationality` | ISO alpha-2; não deduzir do CPF ou endereço |
| Telefone estruturado | Cliente | `individual.phone.country_code` e `.number` | Código de discagem separado do número; não usar só o phone livre do topo |
| Logradouro | Cliente | `individual.residential_address.line1` | Nome da rua separado do número |
| Número | Cliente | `individual.residential_address.number` | String, não inteiro; não fabricar valor se não informado |
| Bairro | Cliente | `individual.residential_address.neighborhood` | Campo separado |
| Cidade | Cliente | `individual.residential_address.city` | Campo separado |
| Estado | Cliente | `individual.residential_address.state` | Validar representação aceita no teste de integração; schema não fixa uma enumeração brasileira |
| CEP | Cliente | `individual.residential_address.postal_code` | Validar CEP brasileiro, sem inventar endereço |
| País de residência | Cliente | `individual.residential_address.country` | ISO alpha-2; primeira implementação brasileira deve declarar a restrição atendida |
| Complemento | Cliente, opcional | `individual.residential_address.complement` | Pode ficar ausente |
| Origem dos recursos | Cliente | `individual.source_of_funds` | Declaração do cliente, sem valor padrão |
| Renda mensal em USD | Cliente | `individual.monthly_income_usd` | Número finito não negativo; zero é resposta válida e não equivale a ausência |
| Volume mensal esperado em USD | Cliente | `individual.expected_monthly_volume_usd` | Mesma unidade explícita, sem supor equivalência em BRL |
| Ocupação | Cliente, complementar | `individual.occupation` | Schema aceita; não inferir de renda |
| Finalidade da conta | Cliente, complementar | `individual.account_purpose` | Schema aceita; não preencher em nome do usuário |
| Declaração PEP | Cliente, se coletada | `individual.is_pep` | Booleano explícito; ausência não vira false por padrão |

O schema também aceita nome da mãe e gênero, mas não os exige para o onboarding PF brasileiro descrito. Não aumentar a coleta apenas porque um campo existe. Novas exigências devem ser justificadas por requisito do provedor/produto. PJ continua disponível no perfil mínimo; formulário empresarial, representantes e beneficiários finais ficam em contrato posterior.

O backend deve rejeitar campos de controle no payload: owner/user/customer IDs, ambiente, provider ID, modo de verificação, status, aprovação, flags financeiras e parâmetros de custódia. Documentos e selfies não fazem parte deste formulário de dados cadastrais.

## 3. Termos antes da criação full

A organização atual possui `kyc_reliance`. Omitir `verification_mode` pode selecionar reliance, que é uma declaração de que o integrador já identificou a pessoa. O fluxo proposto sempre solicita **full**; não usa reliance como fallback.

Para full destinado a liquidar/manter recursos em live, a documentação exige:

1. Backend cria `POST /customers/terms-sessions` e guarda o token `ts_...`, a versão, a URL e a expiração antes de apresentar a sessão.
2. Frontend mostra `terms_url` ao usuário e coleta uma ação explícita de aceite, sem caixa pré-selecionada nem aceite automático pelo login.
3. Backend registra o aceite em `POST /customers/terms-sessions/accept`, para a sessão vinculada àquela conta, com identidade do aceitante e evidência da ação.
4. Backend inclui o mesmo `terms_session_id` na criação do cliente full.

O token é retornado **somente na criação**. Mesmo replay idempotente não o devolve. Persistir antes de responder ao navegador; guardar como segredo protegido no servidor, sem colocá-lo em URLs, logs, analytics ou respostas públicas. Expor ao frontend um ID local opaco para selecionar a sessão pertencente ao usuário, não aceitar tokens arbitrários do navegador.

Se uma resposta se perder antes de recuperar/salvar o token, registrar o resultado incerto e iniciar recuperação controlada; não ficar repetindo a criação esperando que o token reapareça. Sessão expirada precisa de novo fluxo de apresentação/aceite. O replay do aceite é idempotente e não reescreve a evidência original.

Hora do aceite deve ser registrada pelo servidor. IP de origem só pode vir de uma cadeia de proxy confiável configurada; não confiar em um X-Forwarded-For arbitrário nem em IP declarado no JSON. User-agent é evidência contextual, não prova de identidade. A evidência é uma declaração sobre a ação real do cliente; nunca gerá-la por script em nome dele.

**Limite do sandbox:** o parceiro simula a aceitação e não valida o terms_session_id da mesma forma. Um 201 sandbox não comprova que o aceite funciona em live.

## 4. Criação e início da verificação

Após dados válidos e aceite registrado, o backend reserva uma intenção de criação com chave idempotente e hash da representação normalizada. O mesmo retry precisa manter dono, ambiente, payload e chave. Uma resposta incerta não autoriza criar outro cliente nem adotar um ID informado num erro de duplicidade. external_ref é um correlacionador, não uma chave única nem uma prova de propriedade.

Custódia é uma escolha de produto a resolver explicitamente antes de ativar o cadastro real. Os testes usaram managed somente para a fixture. Com ambos os produtos na organização, omitir custody_model pode selecionar self_custody e exigir endereço. Não herdar automaticamente a escolha da fixture para live. O vínculo de carteira/assinatura e o envio final de USDT precisam ser desenhados de acordo com essa escolha.

A criação deve manter `verification_mode: full`, e validar no retorno ID, ambiente e correlação. Um retorno aprovado não libera operações por si só. O backend conserva separadas a observação do provedor, as exigências pendentes e a autorização local.

Para captura de identidade, `POST /verifications` recebe o customer_id **do vínculo do servidor** e as capacidades solicitadas. Documento (`kyc_document`), prova de vida (`liveness`) e comparação facial (`face_match`) são candidatos para a jornada PF, sujeitos às capacidades e à política aprovada; não afirmar que essas verificações já foram executadas.

### Estados que a interface deve distinguir

| Situação | O que mostrar/fazer |
| --- | --- |
| Cadastro mínimo sem dados legais | Solicitar preenchimento |
| Dados com pendências conhecidas | Mostrar os campos permitidos que faltam |
| Termos não aceitos/expirados | Apresentar termos válidos e pedir aceite |
| Criação incerta | Mostrar processamento/reconciliação, sem botão de criar outro cliente |
| Verificação criada com session_url | Oferecer acesso ao link validado recebido do servidor |
| Verificação pending sem session_url | Informar indisponibilidade/espera; não fabricar link nem criar sessões em loop |
| Em análise | Mostrar acompanhamento sem promessa de aprovação |
| Approved com pendências | Mostrar exigências e manter a autorização local separada |
| Rejected/expired | Mostrar estado e orientação definida pelo fluxo, sem autoaprovação |
| Estado/requisitos ausentes ou não reconhecidos | Mostrar análise pendente/indisponível; não tratar desconhecido como aprovado |

**Sandbox nunca retorna session_url.** Seu caminho de teste é criar a verificação e usar `/verifications/{id}/simulate` com approved/rejected, sempre como simulação e sem documentos reais.

Em live, a existência de session_url depende das capacidades pedidas e de uma configuração global do parceiro para captura hospedada. Pode haver uma verificação válida, pending, sem URL. Essa configuração não é algo que nossa API consiga habilitar para a organização. Só um teste live controlado pode demonstrar captura real; autorização comercial e sucesso em sandbox não provam disponibilidade técnica da sessão.

## 5. Armazenamento, retorno e observação

Antes de armazenar CPF, endereço, data de nascimento ou token de termos, implementar o modelo de dados, proteção dos campos sensíveis, acesso exclusivamente pelo backend, redação de logs e a política operacional de acesso/retenção. O modelo mínimo de perfil atual não é um depósito de dados legais. A chave de proteção não pode ser colocada no frontend ou junto ao dado cifrado na tabela.

Não salvar corpos completos de requisições/respostas em recibos de idempotência, filas ou eventos. Se for necessário persistir payload para retry, ele também precisa de proteção. Um hash simples de CPF tem baixa resistência a enumeração; não usá-lo como forma de ocultar o documento. Reaproveitar os guardas e RLS existentes, sem liberar consulta direta por anon/authenticated.

Status e requisitos podem ser expostos com códigos de campos permitidos e mensagens locais. O snapshot atual guarda apenas contagens de campos faltantes: ainda **não** permite montar automaticamente todos os nove campos relatados na fixture. A nova integração deve mapear tokens conhecidos de missing_fields com allowlist, tratando tokens desconhecidos como pendência genérica, sem renderizar HTML/prosa arbitrária do provedor.

O processamento de webhook deve resolver o novo vínculo por ambiente e consultar o estado atual, não usar o snapshot do evento como autorização. Consultas manuais e notificações continuam sem liberar pagamentos. Credenciais e segredos não entram na documentação entregue a novos desenvolvedores.

## 6. Endpoints Peragus propostos — ainda não implementados

Os caminhos abaixo são proposta de contrato, não podem ser usados no frontend como rotas já disponíveis. Consolidar schema/erros com a implementação e publicar a versão final antes de integrar a tela.

| Caminho proposto | Função e restrição |
| --- | --- |
| GET /v1/me/onboarding | Estado local da jornada, requisitos normalizados, possibilidades reais da próxima ação; nunca token secreto |
| PUT /v1/me/onboarding/individual | Validar/salvar dados PF da própria conta; não criar cliente nem atestar aceite |
| POST /v1/me/onboarding/terms | Criar/retomar sessão local e fornecer URL/versão/expiração |
| POST /v1/me/onboarding/terms/accept | Registrar ação explícita da conta para sua sessão local |
| POST /v1/me/onboarding/submit | Criar cliente full com intenção idempotente, dados e termos válidos; sem pagamento |
| POST /v1/me/onboarding/verification | Iniciar/recuperar verificação vinculada; URL somente quando de fato recebida |

Todos exigem sessão confirmada, PF próprio e controle de suspensão. Não aceitar email/senha Supabase nesses endpoints. Sem seleção de outro customer por query/body. Provider errors precisam de tradução para erros seguros; não expor identidades duplicadas. A revisão de PJ e a assinatura de carteira são fluxos distintos.

## 7. Ordem de implementação e critérios de aceite

1. Schema PF brasileiro, validação, representação de pendências e contrato de erros; testes com dados sintéticos. Nenhum dado real enviado ao sandbox.
2. Persistência protegida de rascunho e de tokens/evidências de termos, isolamento por conta, intenções idempotentes e recuperação de resultado incerto.
3. Endpoints de termos e integração frontend de apresentação/aceite. Verificar permissões e diferenças reais de sandbox, sem presumir que o gate live foi exercitado.
4. Vínculo cadastral novo e separado de fixture/live, escolha explícita de custódia, criação full e extensão do webhook para o novo modelo.
5. Verificação sandbox e simulação de ambos os resultados; pending sem URL, duplicidades, retries, expiração, ausência de capacidade e falhas de gravação.
6. Integração da tela pelo responsável de frontend, incluindo proxy de Authorization, erros, sessão e apresentação honesta dos estados.
7. Só então validar disponibilidade live de termos/captura e planejar um teste real controlado. Isso não habilita flags financeiras; KYC, carteira, Travel Rule, limites e execução financeira continuam com critérios próprios.

Próxima entrega de código: schema/validação e estado da jornada antes da coleta real. Este contrato não exige migration nem deploy e não altera as flags do staging.
