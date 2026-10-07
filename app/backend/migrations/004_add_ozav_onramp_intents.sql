create table settlement_ozav_onramp_intents (
    settlement_id uuid primary key references settlements (id),
    environment text not null default 'test'
        check (environment = 'test'),
    customer_id varchar(128) not null,
    wallet_id varchar(128) not null,
    source_amount_brl varchar(64) not null,
    spread_bps integer not null,
    idempotency_key varchar(256) not null unique,
    quote_id varchar(128) unique,
    quote_target_amount_usdt varchar(64),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    check (customer_id ~ '^ozav_cus_[A-Za-z0-9_]+$'),
    check (wallet_id ~ '^ozav_wal_[A-Za-z0-9_]+$'),
    check (
        source_amount_brl ~ '^[0-9]+(\.[0-9]{1,2})?$'
    ),
    check (spread_bps between 0 and 10000),
    check (
        idempotency_key ~ '^[A-Za-z0-9_-]{16,256}$'
    ),
    check (
        quote_id is null
        or quote_id ~ '^ozav_q_[A-Za-z0-9_]+$'
    ),
    check (
        quote_target_amount_usdt is null
        or quote_target_amount_usdt
            ~ '^[0-9]+(\.[0-9]{1,6})?$'
    ),
    check (
        (quote_id is null)
        = (quote_target_amount_usdt is null)
    )
);

alter table settlement_ozav_onramp_intents
    enable row level security;
