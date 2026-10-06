create table if not exists settlements (
    id uuid primary key,
    request_id varchar(128) not null unique,
    request_payload_hash char(64) not null,
    request_payload jsonb not null,

    corridor_id char(64) not null,
    payer_wallet varchar(44) not null,
    recipient_wallet varchar(44) not null,
    source_amount numeric(20, 0) not null,
    destination_amount numeric(20, 0) not null,
    expires_at timestamptz not null,

    status varchar(32) not null default 'received',

    provider varchar(64),
    provider_reference varchar(255),
    settlement_pda varchar(44),
    create_signature varchar(128),
    execute_signature varchar(128),
    failure_code varchar(128),
    failure_message text,

    version integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint settlements_request_payload_hash_format
        check (request_payload_hash ~ '^[0-9a-f]{64}$'),

    constraint settlements_corridor_id_format
        check (corridor_id ~ '^[0-9a-f]{64}$'),

    constraint settlements_source_amount_positive
        check (
            source_amount > 0
            and source_amount <= 18446744073709551615
        ),

    constraint settlements_destination_amount_positive
        check (
            destination_amount > 0
            and destination_amount <= 18446744073709551615
        ),

    constraint settlements_status_valid
        check (
            status in (
                'received',
                'attested',
                'submitted',
                'settled',
                'failed',
                'expired',
                'manual_review'
            )
        )
);

alter table settlements enable row level security;

create index if not exists settlements_status_created_at_idx
    on settlements (status, created_at);

create index if not exists settlements_expires_at_idx
    on settlements (expires_at)
    where status not in ('settled', 'failed', 'expired');

create or replace function peragus_set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    new.version = old.version + 1;
    return new;
end;
$$;

drop trigger if exists settlements_set_updated_at on settlements;

create trigger settlements_set_updated_at
before update on settlements
for each row
execute function peragus_set_updated_at();
