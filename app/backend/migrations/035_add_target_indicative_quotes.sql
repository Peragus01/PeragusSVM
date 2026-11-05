-- Store the requested side before the one-shot provider POST. Zero source is only an unresolved placeholder.
alter table peragus_customer_indicative_quotes add column target_amount_usdt numeric(12,6) check(target_amount_usdt>0 and target_amount_usdt<1000000);
alter table peragus_customer_indicative_quotes drop constraint peragus_customer_indicative_quotes_source_amount_brl_check;
alter table peragus_customer_indicative_quotes add constraint indicative_source_amount_valid check(
 (source_amount_brl>0 and source_amount_brl<=10000) or (source_amount_brl=0 and target_amount_usdt is not null and observation is null and provider_quote_id is null));
