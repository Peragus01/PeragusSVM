-- Additive metadata; legacy rows remain unowned and executable only under existing gates.
alter table settlements add column record_only boolean not null default false;
alter table settlements add constraint settlements_record_only_valid
    check (not record_only or (customer_id is not null and status = 'created'));

-- Preserve legacy idempotency separately; never merge or reassign existing rows.
create unique index settlements_customer_request_id_idx
    on settlements(customer_id, request_id) where customer_id is not null;
create unique index settlements_legacy_request_id_idx
    on settlements(request_id) where customer_id is null;
alter table settlements drop constraint settlements_request_id_key;

create function peragus_guard_record_only_settlement()
returns trigger language plpgsql as $$
begin
    if old.record_only and (
        new.record_only is distinct from old.record_only
        or new.customer_id is distinct from old.customer_id
    ) then
        raise exception 'Record-only settlements cannot be promoted or reassigned';
    end if;
    return new;
end;
$$;
create trigger settlements_guard_record_only
before update on settlements
for each row execute function peragus_guard_record_only_settlement();
