# Backup e restauração do banco de produção

Objetivo: ter um dump **externo** do banco de produção (projeto Supabase `athwkklyvnaetotmancy`) toda semana e provar,
ao menos uma vez antes do Go/No-Go (critério 16), que ele restaura em um banco descartável. Um backup que nunca foi
restaurado não conta.

Todos os comandos usam **placeholders**. Nunca escreva a URL real, a senha ou o dump em chat, no repositório ou em logs.
Guarde a connection string apenas em um gerenciador de senhas/variável de ambiente local da sessão do terminal.

## O que é copiado e onde guardar

- Dump lógico do esquema `public` (tabelas da aplicação, incluindo `peragus_database_environment`, controles e auditoria; a fila `pgboss` fica em outro esquema e é efêmera, não precisa de backup)
  e do esquema `auth` apenas se desejar preservar usuários (veja a nota abaixo).
- Local externo: armazenamento fora do Supabase e fora do Railway (ex.: bucket de nuvem privado de outra conta ou disco criptografado
  offline). Cifre o dump antes de enviar (`age`/`gpg`). Retenção sugerida: 8 semanais + 3 mensais.
- O dump contém dados pessoais e financeiros: acesso restrito ao responsável.

Nota: o Supabase também faz backups gerenciados conforme o plano; **eles não substituem** o dump externo, pois ficam na
mesma plataforma/conta. Registre qual plano e janela de retenção estão ativos no painel (Database › Backups).

## 1. Dump semanal

Pré-requisitos: cliente PostgreSQL 17 (`pg_dump`), acesso à rede para o host do banco e a string de conexão **direta ou do pooler
em modo sessão** (porta 5432), nunca a de transação (porta 6543) para `pg_dump`.

```bash
# 1) Defina a conexão só na sessão do terminal (não grave em arquivo versionado nem no histórico do shell).
read -rs PROD_DATABASE_URL     # cole: postgresql://postgres:<SENHA>@<HOST>:5432/postgres ; Enter
export PROD_DATABASE_URL

# 2) Dump no formato custom (compactado, permite restauração seletiva).
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump "$PROD_DATABASE_URL" \
  --format=custom --no-owner --no-privileges \
  --schema=public \
  --file="peragus-prod-$STAMP.dump"

# 3) Checagem de integridade do arquivo e inventário.
pg_restore --list "peragus-prod-$STAMP.dump" | head -20
sha256sum "peragus-prod-$STAMP.dump" > "peragus-prod-$STAMP.dump.sha256"   # hash do dump em claro (verificado após decifrar)

# 4) Cifrar e enviar para o armazenamento externo (exemplo com age; use a chave pública do responsável).
age -r <CHAVE-PUBLICA-AGE> -o "peragus-prod-$STAMP.dump.age" "peragus-prod-$STAMP.dump"
sha256sum "peragus-prod-$STAMP.dump.age" > "peragus-prod-$STAMP.dump.age.sha256"   # hash do arquivo cifrado (verificado antes de decifrar)
# envie "peragus-prod-$STAMP.dump.age", "peragus-prod-$STAMP.dump.age.sha256" e "peragus-prod-$STAMP.dump.sha256" para <DESTINO-EXTERNO> com a ferramenta do provedor

# 5) Apague a cópia local em claro e limpe a variável.
shred -u "peragus-prod-$STAMP.dump" 2>/dev/null || rm -f "peragus-prod-$STAMP.dump"
unset PROD_DATABASE_URL
```

Se também quiser os usuários do Auth (necessário para uma restauração completa do projeto): acrescente
`--schema=auth` ao `pg_dump` (e restaure em projeto Supabase, nunca em Postgres comum sem as extensões do Supabase). Para a
recuperação de desastre, o caminho mais simples é restaurar `public` no novo projeto e pedir novo login aos usuários;
decida isto uma vez e registre aqui.

### Agendamento semanal

Escolha **um** (e registre qual):

- **Lembrete + execução manual** semanal (ex.: segunda 07:00 America/Sao_Paulo) com o script acima — aceitável para o piloto.
- **GitHub Actions agendado** (`schedule`) em repositório **privado** próprio de operações, com `PROD_DATABASE_URL` e a chave pública `age` como
  secrets desse repositório e upload para o bucket externo. Não use o repositório da aplicação para isto.
- **Job agendado** (cron) em uma máquina do responsável, com a conexão em cofre local.

Evidência a anexar ao registro de operação: data/hora do último dump, tamanho, hash `sha256`, local externo, quem executou.
Alerte-se se passar de 8 dias sem dump.

## 2. Teste de restauração em banco descartável (obrigatório uma vez; repetir a cada trimestre)

Nunca restaure sobre produção nem sobre staging. Use um Postgres **descartável**: um container local ou um projeto/branch
Supabase temporário criado só para o teste e excluído depois.

```bash
# A) Banco descartável local (Docker). Imagem na mesma major do Supabase (17).
docker run -d --name peragus-restore-test -e POSTGRES_PASSWORD=<SENHA-TEMPORARIA> -p 55432:5432 postgres:17
export RESTORE_DATABASE_URL="postgresql://postgres:<SENHA-TEMPORARIA>@127.0.0.1:55432/postgres"

# B) Traga o dump do armazenamento externo, confira o hash e decifre.
sha256sum -c "peragus-prod-<STAMP>.dump.age.sha256"   # hash do arquivo cifrado, antes de decifrar
age -d -i <ARQUIVO-DE-CHAVE-PRIVADA-AGE> -o "peragus-prod-<STAMP>.dump" "peragus-prod-<STAMP>.dump.age"
sha256sum -c "peragus-prod-<STAMP>.dump.sha256"       # hash do dump em claro, depois de decifrar

# C) Prepare papéis exigidos pelo dump (o Supabase usa estes papéis em GRANTs; sem eles aparecem avisos).
psql "$RESTORE_DATABASE_URL" -c "create role anon nologin; create role authenticated nologin; create role service_role nologin;" || true

# D) Restaure.
pg_restore --no-owner --no-privileges --exit-on-error \
  --dbname="$RESTORE_DATABASE_URL" "peragus-prod-<STAMP>.dump"

# E) Verifique integridade lógica.
psql "$RESTORE_DATABASE_URL" <<'SQL'
select environment from peragus_database_environment;          -- deve ser 'live'
select count(*) as migrations from peragus_schema_migrations;   -- compare com o número de arquivos em app/backend/migrations
select key, enabled, environment from peragus_runtime_controls order by key;
select count(*) from peragus_customer_purchase_intents;
select count(*) from peragus_operation_status_events;
select count(*) from peragus_daily_reviews;
select count(*) from peragus_operator_notifications;
SQL

# F) Compare contagens com as de produção (somente leitura) e registre diferenças aceitáveis (linhas criadas após o dump).

# G) Destrua o ambiente descartável e todas as cópias em claro.
docker rm -f peragus-restore-test
shred -u "peragus-prod-<STAMP>.dump" 2>/dev/null || rm -f "peragus-prod-<STAMP>.dump"
unset RESTORE_DATABASE_URL
```

Se o dump incluir `auth`, restaure em um **projeto Supabase temporário** (Database › Restore/`pg_restore` com a string do projeto temporário) e exclua o projeto depois.

Notas de verificação: a tabela de controle de migrations é `peragus_schema_migrations` (criada por `app/backend/scripts/migrate.mjs`). Se `pg_restore` abortar por extensão ausente (ex.: `pgcrypto`, `pg_cron`), instale a extensão no banco descartável
e repita; registre a extensão como requisito de restauração.

### Critérios de sucesso do teste

- `pg_restore` termina sem erro (avisos de papéis/GRANT documentados são aceitáveis).
- `peragus_database_environment.environment = 'live'`, número de migrations igual ao esperado e contagens próximas às da produção.
- Tempo total medido e registrado (meta de recuperação: horas, não dias).
- Descartável destruído e dump em claro apagado.

### Registro do teste

| Campo | Valor |
|---|---|
| Data / responsável | |
| Dump usado (STAMP, tamanho, sha256) | |
| Onde foi restaurado (local Docker / projeto temporário) | |
| Duração | |
| Resultado das consultas de verificação | |
| Divergências e explicação | |
| Ambiente descartável destruído em | |

## 3. Recuperação real (resumo)

1. Pause tudo (`operator-runbook.md` seção 1) e desligue o tráfego se necessário.
2. Crie o novo projeto/banco, rode o restore da seção 2 (etapas B–E) e aponte `DATABASE_URL` (API e workers) para ele.
3. Rode `npm run db:migrate` com `PERAGUS_DEPLOYMENT_ENV=production` para aplicar migrations posteriores ao dump.
4. Reconcilie com a OZAV (GET) toda operação posterior ao dump; **nunca** reenvie USDT sem confirmar com a OZAV que nenhuma transfer existe.
5. Só religue as chaves depois de uma revisão manual das operações entre o dump e o incidente.
