-- Sanitized sandbox provider snapshots; never customer approval or operation grants.
alter table peragus_ozav_sandbox_customer_links
  add column provider_snapshot jsonb check (provider_snapshot is null or jsonb_typeof(provider_snapshot) = 'object'),
  add column snapshot_version integer not null default 0 check (snapshot_version >= 0),
  add column refreshed_at timestamptz;
