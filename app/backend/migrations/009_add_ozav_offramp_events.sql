create table settlement_ozav_offramp_events (
    event_id varchar(128) primary key,
    settlement_id uuid not null
        references settlement_ozav_offramp_intents (settlement_id),
    transfer_id varchar(128) not null,
    event_type varchar(128) not null,
    occurred_at timestamptz not null,
    received_at timestamptz not null default now(),
    processed_at timestamptz,
    content_hash char(64) not null,
    snapshot jsonb not null,

    check (event_id ~ '^ozav_evt_[A-Za-z0-9_]+$'),
    check (transfer_id ~ '^ozav_tr_[A-Za-z0-9_]+$'),
    check (event_type like 'transfer.%'),
    check (content_hash ~ '^[0-9a-f]{64}$'),
    check (jsonb_typeof(snapshot) = 'object')
);

create index settlement_ozav_offramp_events_order_idx
    on settlement_ozav_offramp_events (
        settlement_id,
        occurred_at,
        event_id
    );

alter table settlement_ozav_offramp_events
    enable row level security;
