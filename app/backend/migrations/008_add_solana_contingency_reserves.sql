create table settlement_solana_contingency_reserves (
    settlement_id uuid primary key references settlements (id),
    reserve_pda varchar(44) not null unique,
    vault_pda varchar(44) not null unique,
    amount_usdt varchar(64) not null,
    amount_base_units numeric(20, 0) not null,
    fallback_after timestamptz not null,
    expires_at timestamptz not null,
    create_signature varchar(128) not null unique,
    settle_signature varchar(128) unique,
    refund_signature varchar(128) unique,
    status varchar(16) not null default 'funded',
    version integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    check (char_length(reserve_pda) between 32 and 44),
    check (char_length(vault_pda) between 32 and 44),
    check (amount_usdt ~ '^[0-9]+(\.[0-9]{1,6})?$'),
    check (
        amount_base_units > 0
        and amount_base_units <= 18446744073709551615
    ),
    check (fallback_after < expires_at),
    check (status in ('funded', 'settled', 'refunded')),
    check (
        (status = 'funded'
            and settle_signature is null
            and refund_signature is null)
        or
        (status = 'settled'
            and settle_signature is not null
            and refund_signature is null)
        or
        (status = 'refunded'
            and settle_signature is null
            and refund_signature is not null)
    )
);

create index settlement_solana_reserves_status_fallback_idx
    on settlement_solana_contingency_reserves (
        status,
        fallback_after
    );

alter table settlement_solana_contingency_reserves
    enable row level security;

create trigger settlement_solana_reserves_set_updated_at
before update on settlement_solana_contingency_reserves
for each row
execute function peragus_set_updated_at();
