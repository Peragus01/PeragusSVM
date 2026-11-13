-- One money environment per database: test+solana:devnet or live+solana:mainnet.
-- Guards the money tables and the customer onboarding/invitation tables.
-- scripts/migrate.mjs records the environment in the same transaction as this
-- migration (Ruling 40) and again at the end; until then every
-- insert or update on a money table is rejected (fail closed).
create table peragus_database_environment (
 singleton boolean primary key default true check(singleton),
 environment text not null check(environment in ('test','live')),
 recorded_at timestamptz not null default now()
);
alter table peragus_database_environment enable row level security;
revoke all on peragus_database_environment from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then execute 'revoke all on peragus_database_environment from anon'; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then execute 'revoke all on peragus_database_environment from authenticated'; end if;
end $$;

create function peragus_guard_database_environment() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin raise exception 'DATABASE_ENVIRONMENT_IMMUTABLE'; end $$;
create trigger peragus_database_environment_immutable before update or delete on peragus_database_environment
 for each row execute function peragus_guard_database_environment();
create trigger peragus_database_environment_no_truncate before truncate on peragus_database_environment
 for each statement execute function peragus_guard_database_environment();

create function peragus_enforce_row_environment() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
declare recorded text;
begin
 select d.environment into recorded from public.peragus_database_environment d where d.singleton;
 if recorded is null or new.environment is distinct from recorded then
  raise exception 'ENVIRONMENT_MISMATCH';
 end if;
 return new;
end $$;

do $$
declare
 spec text[];
 t text;
 net text;
 c record;
 r text;
begin
 -- {table, network column or ''}. The execution table's `network` is the
 -- provider chain name ('solana'), not the CAIP-2 network, and is left as is.
 foreach spec slice 1 in array array[
  ['peragus_customer_wallet_challenges',''],
  ['peragus_customer_wallets','network'],
  ['peragus_customer_indicative_quotes',''],
  ['peragus_customer_purchase_intents','wallet_proof_network'],
  ['peragus_customer_sandbox_pix',''],
  ['peragus_customer_withdrawal_requests','proof_network'],
  ['peragus_withdrawal_operator_approvals',''],
  ['peragus_sandbox_withdrawal_executions',''],
  ['peragus_customer_refund_requests',''],
  ['peragus_customer_reconciliation',''],
  -- Customer onboarding and invitation tables (012-019, 030, 037, 038, 040).
  -- Legacy hackathon tables (003, 004, 007) and sandbox-only 031/033 stay test-only.
  ['peragus_ozav_sandbox_customer_links',''],
  ['peragus_customer_webhook_events',''],
  ['peragus_individual_onboarding_drafts',''],
  ['peragus_customer_terms_sessions',''],
  ['peragus_customer_onboarding_submissions',''],
  ['peragus_customer_verifications',''],
  ['peragus_customer_screenings',''],
  ['peragus_pilot_invites',''],
  ['peragus_onboarding_email_outbox',''],
  ['peragus_customer_document_uploads',''],
  ['peragus_invite_email_outbox','']
 ] loop
  t := spec[1];
  net := spec[2];
  -- Drop the single-column CHECKs on environment/network, whatever their generated names.
  for c in
   select con.conname
   from pg_constraint con
   join pg_attribute a on a.attrelid=con.conrelid and a.attnum=con.conkey[1]
   where con.conrelid=format('public.%I',t)::regclass and con.contype='c'
    and array_length(con.conkey,1)=1 and a.attname in ('environment',nullif(net,''))
  loop
   execute format('alter table public.%I drop constraint %I',t,c.conname);
  end loop;
  execute format('alter table public.%I alter column environment drop default',t);
  execute format('alter table public.%I add constraint peragus_row_environment_check check(environment in (''test'',''live''))',t);
  if net<>'' then
   execute format('alter table public.%I alter column %I drop default',t,net);
   execute format('alter table public.%I add constraint peragus_row_network_check check(%I in (''solana:devnet'',''solana:mainnet''))',t,net);
   execute format('alter table public.%I add constraint peragus_row_environment_network_check check((environment=''test'' and %I=''solana:devnet'') or (environment=''live'' and %I=''solana:mainnet''))',t,net,net);
  end if;
  execute format('create trigger peragus_row_environment_guard before insert or update on public.%I for each row execute function peragus_enforce_row_environment()',t);
 end loop;

 foreach r in array array['peragus_enforce_row_environment()','peragus_guard_database_environment()'] loop
  execute format('revoke execute on function %s from public',r);
  if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke execute on function %s from anon',r); end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then execute format('revoke execute on function %s from authenticated',r); end if;
 end loop;
end $$;
