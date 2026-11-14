-- Server-side legal acceptance (Task 12). Append-only evidence that a customer
-- accepted an exact version (and content hash) of a required document. Carries the
-- row environment and the 043 guard; no client role can read or write it directly.
create table peragus_customer_legal_acceptances (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null,
 customer_id uuid not null references peragus_customers(id),
 document text not null check(document in ('terms','privacy','refund')),
 version text not null check(length(version) between 1 and 100 and version !~ '[[:cntrl:]]'),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 accepted_at timestamptz not null default now(),
 ip inet,
 user_agent text check(user_agent is null or length(user_agent)<=512),
 environment text not null constraint peragus_row_environment_check check(environment in ('test','live')),
 unique(customer_id,document,version,sha256,environment)
);
create index peragus_customer_legal_acceptances_customer on peragus_customer_legal_acceptances(customer_id);
alter table peragus_customer_legal_acceptances enable row level security;
revoke all on peragus_customer_legal_acceptances from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then execute 'revoke all on peragus_customer_legal_acceptances from anon'; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then execute 'revoke all on peragus_customer_legal_acceptances from authenticated'; end if;
end $$;
create trigger peragus_row_environment_guard before insert or update on peragus_customer_legal_acceptances
 for each row execute function peragus_enforce_row_environment();

create function peragus_legal_acceptances_append_only() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin raise exception 'LEGAL_ACCEPTANCES_APPEND_ONLY'; end $$;
create trigger peragus_legal_acceptances_immutable before update or delete on peragus_customer_legal_acceptances
 for each row execute function peragus_legal_acceptances_append_only();
-- TRUNCATE is left to the owner role (same as the other append-only logs, 029/036/045);
-- a guarded truncate would also break TRUNCATE ... CASCADE from peragus_customers.
revoke execute on function peragus_legal_acceptances_append_only() from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then execute 'revoke execute on function peragus_legal_acceptances_append_only() from anon'; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then execute 'revoke execute on function peragus_legal_acceptances_append_only() from authenticated'; end if;
end $$;
