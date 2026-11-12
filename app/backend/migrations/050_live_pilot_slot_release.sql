-- On-chain delivery evidence and live pilot slot release (Task 11).
--
-- * delivery_status: outcome of the independent on-chain check of the send.
--     verified  - the finalized transaction credited the customer's wallet with the expected
--                 mint and amount; the operation is delivered_verified.
--     simulated - test mode only: the sandbox transaction is not on devnet; the operation stays sent.
--     review    - the chain disagrees (failed tx, other mint, other recipient, other amount) or
--                 OZAV reported a net amount below locked - tolerance; the operation is needs_review.
-- * delivered_amount_usdt: what the wallet was credited on chain (net of the network fee).
-- * refused_transfer_id: a transfer found by metadata (GET only) for a send OZAV answered as
--   refused. It must not exist; an operator checks it before anything else is done.
-- * slot_released_at: the global pilot slot is given back without the sandbox closure.
alter table peragus_sandbox_withdrawal_executions
 add column delivery_status text check(delivery_status is null or delivery_status in ('verified','simulated','review')),
 add column delivery_reason text check(delivery_reason is null or (length(delivery_reason) between 1 and 200 and delivery_reason !~ '[[:cntrl:]]')),
 add column delivered_amount_usdt numeric(21,6) check(delivered_amount_usdt is null or delivered_amount_usdt>0),
 add column delivery_checked_at timestamptz,
 add column refused_transfer_id text check(refused_transfer_id is null or refused_transfer_id ~ '^ozav_tr_[A-Za-z0-9_-]{1,120}$'),
 add column slot_released_at timestamptz,
 add constraint peragus_execution_delivery_evidence check(
  (delivery_status is null and delivery_reason is null and delivered_amount_usdt is null and delivery_checked_at is null)
  or (delivery_status is not null and delivery_reason is not null and delivery_checked_at is not null
   and create_attempted and provider_send_id is not null and observation is not null
   and (delivery_status='verified')=(delivered_amount_usdt is not null)
   and (delivery_status<>'verified' or provider_tx_hash is not null)
   and (delivery_status<>'simulated' or environment<>'live'))),
 add constraint peragus_execution_delivered_within_sent check(delivered_amount_usdt is null or delivered_amount_usdt<=coalesce(send_amount_usdt,amount_usdt)),
 add constraint peragus_execution_refused_transfer_only_when_refused check(refused_transfer_id is null or provider_refusal_code is not null),
 add constraint peragus_execution_slot_release_live_only check(slot_released_at is null or environment='live');

-- One unresolved execution globally: resolved by the sandbox closure (test) or by the release below (live).
drop index peragus_one_unresolved_sandbox_withdrawal;
create unique index peragus_one_unresolved_sandbox_withdrawal on peragus_sandbox_withdrawal_executions(pilot_slot)
 where closed_at is null and slot_released_at is null;

-- Live: the sandbox closure stays refused, so the slot is released when the operation reaches
-- delivered_verified, refunded or a terminal failure (failed, expired). It runs in the same
-- transaction as the status change, whichever service made it.
create function peragus_release_live_pilot_slot() returns trigger language plpgsql
 set search_path = pg_catalog, public as $$
begin
 if new.environment='live' and new.status is distinct from old.status
  and new.status in ('delivered_verified','refunded','failed','expired') then
  update public.peragus_sandbox_withdrawal_executions e set slot_released_at=now(),updated_at=now()
   from public.peragus_customer_withdrawal_requests r
   where r.purchase_intent_id=new.id and r.customer_id=new.customer_id
    and e.withdrawal_request_id=r.id and e.customer_id=r.customer_id
    and e.environment='live' and e.closed_at is null and e.slot_released_at is null;
 end if;
 return null;
end $$;
create trigger peragus_live_pilot_slot_release after update of status on peragus_customer_purchase_intents
 for each row execute function peragus_release_live_pilot_slot();
do $$ declare r text; begin
 execute 'revoke execute on function peragus_release_live_pilot_slot() from public';
 for r in select rolname from pg_roles where rolname in ('anon','authenticated') loop
  execute format('revoke execute on function peragus_release_live_pilot_slot() from %I',r);
 end loop;
end $$;

-- A frozen token account cannot receive either; it is reported apart from a missing one.
alter table peragus_withdrawal_destination_checks drop constraint peragus_withdrawal_destination_checks_blocker_check;
alter table peragus_withdrawal_destination_checks add constraint peragus_withdrawal_destination_checks_blocker_check
 check(blocker is null or blocker in ('DESTINATION_TOKEN_ACCOUNT_MISSING','DESTINATION_TOKEN_ACCOUNT_FROZEN'));
