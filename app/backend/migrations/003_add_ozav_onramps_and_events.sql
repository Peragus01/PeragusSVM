-- OZAV sandbox correlation only. Fiat amounts are kept in event snapshots,
-- separate from settlements.source_amount / destination_amount (contract units).
create table settlement_ozav_onramps (
    settlement_id uuid primary key references settlements (id),
    environment text not null default 'test' check (environment = 'test'),
    transfer_id varchar(128) not null unique,
    customer_id varchar(128) not null,
    wallet_id varchar(128) not null,
    quote_id varchar(128) not null,
    created_at timestamptz not null default now(),
    unique (settlement_id, transfer_id),
    check (transfer_id ~ '^ozav_tr_[A-Za-z0-9_]+$'),
    check (customer_id ~ '^ozav_cus_[A-Za-z0-9_]+$'),
    check (wallet_id ~ '^ozav_wal_[A-Za-z0-9_]+$'),
    check (quote_id ~ '^ozav_q_[A-Za-z0-9_]+$')
);

create table settlement_ozav_events (
    event_id varchar(128) primary key,
    settlement_id uuid not null,
    transfer_id varchar(128) not null,
    event_type varchar(128) not null,
    occurred_at timestamptz not null,
    received_at timestamptz not null default now(),
    -- Receipt is separate from later application to the settlement state machine.
    processed_at timestamptz,
    content_hash char(64) not null,
    snapshot jsonb not null,
    foreign key (settlement_id, transfer_id)
        references settlement_ozav_onramps (settlement_id, transfer_id),
    check (event_id ~ '^ozav_evt_[A-Za-z0-9_]+$'),
    check (event_type like 'transfer.%'),
    check (content_hash ~ '^[0-9a-f]{64}$'),
    check (jsonb_typeof(snapshot) = 'object')
);

create index settlement_ozav_events_order_idx
    on settlement_ozav_events (settlement_id, occurred_at, event_id);

alter table settlement_ozav_onramps enable row level security;
alter table settlement_ozav_events enable row level security;
