# Convites do piloto PF — backend sandbox

## Política e limites

Cinco vagas no banco, protegidas contra concorrência. A migration 030 associa os perfis PF existentes às vagas, por ordem de criação. Não apaga nem suspende clientes. Se já houver mais de cinco, todos continuam acessíveis, mas não haverá vagas novas. Uma vaga resgatada permanece ocupada; este módulo não exclui perfis nem reabre admissões já usadas.

**Novos perfis exigem convite no runtime com DB mesmo com PILOT_INVITES_ENABLED=false.** A flag controla emissão/resgate/revogação, não reabre cadastro direto. POST /v1/me/customer sem perfil existente retorna 403 PILOT_INVITE_REQUIRED. Perfis existentes continuam acessíveis e podem repetir seu cadastro anterior. O piloto admite novos perfis PF; não cria cadastro PJ.

O convidado primeiro cria e confirma sua conta Supabase Auth e consulta /v1/me para obter seu user.id. Conta Auth não é perfil Peragus nem autorização financeira. O operador emite o convite vinculado a esse UUID, usando conta separada, allowlist existente e MFA aal2. Não há lookup de emails nem uso de service_role.

Códigos têm 256 bits aleatórios, prefixo pginv_, validade de 1 a 168 horas (padrão 24) e resgate único. Só o SHA-256 é armazenado. O segredo é retornado apenas na primeira emissão. O operador entrega o código pelo canal privado escolhido com o convidado; este módulo não envia email. Nunca colocar códigos em URLs, logs, capturas compartilhadas ou no repositório.

## API

Todas as rotas exigem bearer validado pelo Supabase com email confirmado, usam Cache-Control: no-store e rejeitam query selectors. POST aceita JSON de até 4 KiB.

### Emissão — operador com MFA

POST /v1/admin/pilot-invites

```json
{"request_id":"UUID","target_user_id":"UUID_AUTH_DO_CONVIDADO","expires_in_hours":24,"reason":"Motivo interno com pelo menos dez caracteres."}
```

201: data com ID local, vaga, estado, alvo e datas; code somente nesta resposta; meta.idempotent_replay=false. Repetir a mesma chave/corpo retorna 200 com code=null. Alterar alvo, prazo ou motivo na mesma chave gera 409 PILOT_INVITE_IDEMPOTENCY_CONFLICT.

Não existe recuperação do código. Se a resposta se perder, o operador pode repetir para obter o ID, revogar esse convite não usado e emitir outro com nova chave. Um operador ou usuário que já tem perfil não pode ser alvo. Só um convite issued/redeemed por usuário.

### Leitura e revogação — operador com MFA

GET /v1/admin/pilot-invites/:id funciona com a flag false e nunca retorna código/hash.

POST /v1/admin/pilot-invites/:id/revoke

```json
{"request_id":"UUID","reason":"Motivo da revogação do convite não utilizado."}
```

Só convites ainda issued podem ser revogados. Ator, motivo, chave e data ficam registrados. Repetição exata é idempotente. Convite resgatado não é revogado/reaberto; suspensão de cliente segue seu controle próprio. Convites vencidos não podem ser resgatados; uma nova emissão normaliza os vencidos para expired e permite reutilizar vagas não admitidas.

### Resgate — convidado sem perfil

POST /v1/me/pilot-invite/redeem

```json
{"request_id":"UUID","code":"pginv_CODIGO_RECEBIDO","display_name":"Nome do cliente"}
```

O alvo vem exclusivamente da sessão autenticada. Validar convite, criar perfil, consumir o código e ocupar a vaga acontece numa instrução transacional. Falha não deixa perfil parcial nem convite consumido. Código inexistente, conta divergente, revogado ou vencido recebem 409 PILOT_INVITE_NOT_AVAILABLE.

Repetir a mesma chave/código/nome devolve o perfil já criado. Nova chave após consumo não cria novo perfil. O perfil inicia PF/draft, operations_enabled=false. Resgate não aceita termos, aprova KYC, vincula carteira, emite Pix ou solicita retirada.

## Controles

Quota no Postgres: dez tentativas por conta/ação (issue, redeem, revoke) por quinze minutos, compartilhadas entre instâncias/reinícios. Emissão/revogação reconhecidas como replay não gastam nova tentativa; resgate também conta repetições. Excesso: 429 PILOT_INVITE_RATE_LIMITED e Retry-After: 900. Complementa as proteções de login do Supabase e não pretende cobrir as demais rotas da API.

Dados de emissão são imutáveis. Só existe uma transição issued→redeemed/revoked/expired. Registros não podem ser apagados pela aplicação. RLS e revogação de public/anon/authenticated mantêm acesso por trás da API.

## Implantação

1. Build e testes; aplicar 030_add_pilot_invites.sql no staging ANTES do merge/deploy.
2. PILOT_INVITES_ENABLED=false na API e worker. Não há nova chave/segredo.
3. Validar cadastro direto bloqueado e perfis existentes preservados.
4. Para aceitação, habilitar PILOT_INVITES_ENABLED=true somente no PeragusSVM staging. Todas as flags financeiras, de simulação, estorno, retirada e reconciliação permanecem false.
5. Usar conta Auth com email confirmado e sem perfil Peragus. Emitir/resgatar/repetir e conferir PF/draft e ausência de operações habilitadas. A vaga consumida não é liberada automaticamente; usar uma conta destinada ao piloto.
6. Validar conta divergente, ausência de MFA e revogação de convite não usado, sem imprimir códigos em diagnósticos compartilhados.
7. Desabilitar a flag ao terminar. O perfil admitido continua acessível; novos resgates/emissões param.

Não altera frontend, signup do Supabase ou convites de indicação mensal. O responsável pelo portal integrará estas rotas quando a política for validada.
