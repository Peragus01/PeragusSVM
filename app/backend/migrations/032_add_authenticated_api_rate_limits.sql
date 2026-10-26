-- Shared fixed-window quotas for verified Auth identities. No tokens or IPs.
create table peragus_authenticated_api_rate_limits (
 user_id uuid not null,
 bucket text not null check(bucket in ('read','write')),
 window_start timestamptz not null default now(),
 hits smallint not null check(hits between 1 and 61),
 primary key(user_id,bucket)
);
alter table peragus_authenticated_api_rate_limits enable row level security;
revoke all on peragus_authenticated_api_rate_limits from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on peragus_authenticated_api_rate_limits from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on peragus_authenticated_api_rate_limits from authenticated; end if;
end $$;
