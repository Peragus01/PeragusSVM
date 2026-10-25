-- Local GET-only polling checkpoints; independent from financial request claims.
alter table peragus_customer_withdrawal_requests add constraint peragus_withdrawal_purchase_owner_key unique(id,purchase_intent_id,customer_id);
create table peragus_customer_reconciliation (
 id uuid primary key default gen_random_uuid(),
 customer_id uuid not null,
 purchase_intent_id uuid not null,
 pix_id uuid unique,
 withdrawal_request_id uuid unique,
 environment text not null default 'test' check(environment='test'),
 state text not null default 'pending' check(state in ('pending','provider_terminal','needs_review')),
 attempts integer not null default 0 check(attempts between 0 and 120),
 next_check_at timestamptz not null default now(),
 lease_token uuid,
 lease_until timestamptz,
 last_status text check(last_status in ('awaiting_payment','payment_confirmed','converting','payout_initiated','completed','failed','cancelled','expired','needs_review','awaiting_approval','uncertain','reserved')),
 last_error_code text check(last_error_code in ('PROVIDER_READ_UNAVAILABLE','EVIDENCE_MISMATCH','RESOURCE_NOT_FOUND','ATTEMPTS_EXHAUSTED','OBSERVATION_CONFLICT')),
 manual_review_required boolean not null default false,
 first_attempt_at timestamptz,
 last_checked_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 foreign key(purchase_intent_id,customer_id) references peragus_customer_purchase_intents(id,customer_id),
 foreign key(pix_id,purchase_intent_id,customer_id) references peragus_customer_sandbox_pix(id,purchase_intent_id,customer_id),
 foreign key(withdrawal_request_id,purchase_intent_id,customer_id) references peragus_customer_withdrawal_requests(id,purchase_intent_id,customer_id),
 check(num_nonnulls(pix_id,withdrawal_request_id)=1),
 check((lease_token is null)=(lease_until is null))
);
create index peragus_customer_reconciliation_due on peragus_customer_reconciliation(next_check_at,id) where state='pending';
create table peragus_customer_reconciliation_events (
 id bigint generated always as identity primary key,
 reconciliation_id uuid not null references peragus_customer_reconciliation(id),
 attempt integer not null check(attempt between 1 and 120),
 state text not null check(state in ('pending','provider_terminal','needs_review')),
 provider_status text,
 error_code text,
 manual_review_required boolean not null,
 occurred_at timestamptz not null default now(),
 unique(reconciliation_id,attempt)
);
create function peragus_reject_reconciliation_event_mutation() returns trigger language plpgsql as $$
begin raise exception 'reconciliation events are append-only'; end $$;
create trigger peragus_reconciliation_events_immutable before update or delete on peragus_customer_reconciliation_events
 for each row execute function peragus_reject_reconciliation_event_mutation();
alter table peragus_customer_reconciliation enable row level security;
alter table peragus_customer_reconciliation_events enable row level security;
revoke all on peragus_customer_reconciliation,peragus_customer_reconciliation_events from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then
  revoke all on peragus_customer_reconciliation,peragus_customer_reconciliation_events from anon;
 end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then
  revoke all on peragus_customer_reconciliation,peragus_customer_reconciliation_events from authenticated;
 end if;
end $$;
