create table settlement_ozav_offramp_intents (
    settlement_id uuid primary key
        references settlements (id),
    environment text not null default 'test'
        check (environment = 'test'),
    customer_id varchar(128) not null,
    wallet_id varchar(128) not null,
    payout_destination_id varchar(128) not null,
    source_amount_usdt varchar(64) not null,
    spread_bps integer not null,
    idempotency_key varchar(256) not null unique,
    quote_id varchar(128) unique,
    quote_target_amount_brl varchar(64),
    transfer_id varchar(128) unique,
    provider_status varchar(32),
    transfer_source_amount_usdt varchar(64),
    transfer_target_amount_brl varchar(64),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    check (customer_id ~ '^ozav_cus_[A-Za-z0-9_]+$'),
    check (wallet_id ~ '^ozav_wal_[A-Za-z0-9_]+$'),
    check (
        payout_destination_id
            ~ '^ozav_pd_[A-Za-z0-9_]+$'
    ),
    check (
        source_amount_usdt
            ~ '^[0-9]+(\.[0-9]{1,6})?$'
    ),
    check (spread_bps between 0 and 10000),
    check (
        char_length(idempotency_key) between 16 and 256
        and idempotency_key ~ '^[A-Za-z0-9_-]+$'
    ),
    check (
        quote_id is null
        or quote_id ~ '^ozav_q_[A-Za-z0-9_]+$'
    ),
    check (
        quote_target_amount_brl is null
        or quote_target_amount_brl
            ~ '^[0-9]+(\.[0-9]{1,6})?$'
    ),
    check (
        (quote_id is null)
        = (quote_target_amount_brl is null)
    ),
    check (
        transfer_id is null
        or transfer_id ~ '^ozav_tr_[A-Za-z0-9_]+$'
    ),
    check (
        provider_status is null
        or provider_status in (
            'awaiting_payment',
            'payment_confirmed',
            'converting',
            'payout_initiated',
            'completed',
            'failed',
            'cancelled',
            'expired',
            'needs_review',
            'awaiting_approval'
        )
    ),
    check (
        transfer_source_amount_usdt is null
        or transfer_source_amount_usdt
            ~ '^[0-9]+(\.[0-9]{1,6})?$'
    ),
    check (
        transfer_target_amount_brl is null
        or transfer_target_amount_brl
            ~ '^[0-9]+(\.[0-9]{1,6})?$'
    ),
    check (
        (
            transfer_id is null
            and provider_status is null
            and transfer_source_amount_usdt is null
            and transfer_target_amount_brl is null
        )
        or
        (
            transfer_id is not null
            and provider_status is not null
            and transfer_source_amount_usdt is not null
            and transfer_target_amount_brl is not null
        )
    )
);

alter table settlement_ozav_offramp_intents
    enable row level security;
