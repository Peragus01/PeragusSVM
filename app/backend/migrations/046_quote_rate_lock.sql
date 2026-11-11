-- FX rate lock (trava de cambio): live quotes carry the OZAV facility terms version and
-- the USDT amount being locked. The accepted purchase copies both and they never change.
alter table peragus_customer_indicative_quotes
  add column facility_terms_version text check(facility_terms_version is null or length(facility_terms_version) between 1 and 64),
  add column locked_usdt_amount numeric(20,6) check(locked_usdt_amount is null or locked_usdt_amount>0);

-- Existing quotes were all test/indicative: the locked amount is the quoted target.
update peragus_customer_indicative_quotes
   set locked_usdt_amount=(observation->'target'->>'amount')::numeric
 where observation is not null and locked_usdt_amount is null
   and (observation->'target'->>'amount')::numeric>0;

alter table peragus_customer_purchase_intents
  add column facility_terms_version text,
  add column locked_usdt_amount numeric(20,6);

-- Backfill before the trigger below locks these columns.
update peragus_customer_purchase_intents
   set locked_usdt_amount=estimated_target_amount_usdt
 where locked_usdt_amount is null;

drop trigger peragus_purchase_financial_immutable on peragus_customer_purchase_intents;
create trigger peragus_purchase_financial_immutable before update on peragus_customer_purchase_intents
 for each row execute function peragus_purchase_financial_immutable(
  'quote_id','customer_id','provider_customer_id','source_amount_brl','estimated_target_amount_usdt',
  'quote_snapshot','wallet_address','wallet_proof_network','wallet_verified_at',
  'facility_terms_version','locked_usdt_amount','evidence_snapshot');
