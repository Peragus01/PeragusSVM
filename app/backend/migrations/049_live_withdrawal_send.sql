-- Live USDT send with destination identification (Task 10).
--
-- * send_amount_usdt: the amount actually sent, the purchase's immutable locked_usdt_amount
--   (OZAV deducts the network fee from it). NULL only on executions recorded before this
--   version, which sent amount_usdt.
-- * provider_tx_hash: settlement_references.tx_hash as OZAV reported it (send response or GET).
-- * provider_refusal_code: OZAV refused the send definitively (e.g. 422 TRAVEL_RULE_REQUIRED).
--   No transfer exists; the execution is never POSTed again and needs operator review.
alter table peragus_sandbox_withdrawal_executions
 add column send_amount_usdt numeric(21,6) check(send_amount_usdt is null or send_amount_usdt>0),
 add column provider_tx_hash text check(provider_tx_hash is null or (length(provider_tx_hash) between 1 and 256 and provider_tx_hash ~ '^[!-~]+$')),
 add column provider_refusal_code text check(provider_refusal_code is null or provider_refusal_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
 add constraint peragus_execution_send_amount_within_converted check(send_amount_usdt is null or send_amount_usdt<=amount_usdt),
 add constraint peragus_execution_refusal_without_transfer check(provider_refusal_code is null
  or (create_attempted and provider_send_id is null and observation is null and provider_tx_hash is null));

-- Latest destination check before a send: the customer's wallet must hold a token account for
-- the environment's USDT mint. A blocker keeps the operation approved (nothing is claimed or
-- POSTed) and is shown to the customer; a later passing check clears it.
create table peragus_withdrawal_destination_checks (
 withdrawal_request_id uuid primary key,
 customer_id uuid not null,
 blocker text check(blocker is null or blocker in ('DESTINATION_TOKEN_ACCOUNT_MISSING')),
 checked_at timestamptz not null default now(),
 environment text not null check(environment in ('test','live')),
 foreign key(withdrawal_request_id,customer_id) references peragus_customer_withdrawal_requests(id,customer_id)
);
create trigger peragus_row_environment_guard before insert or update on peragus_withdrawal_destination_checks
 for each row execute function peragus_enforce_row_environment();
alter table peragus_withdrawal_destination_checks enable row level security;
revoke all on peragus_withdrawal_destination_checks from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then execute 'revoke all on peragus_withdrawal_destination_checks from anon'; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then execute 'revoke all on peragus_withdrawal_destination_checks from authenticated'; end if;
end $$;
