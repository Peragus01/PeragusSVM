-- Private metadata only. File bytes and signed upload URLs must never be persisted.
create table peragus_customer_document_uploads (
 id uuid primary key,
 customer_id uuid not null references peragus_customers(id),
 provider_customer_id text not null,
 request_id uuid not null,
 doc_type text not null check(doc_type in ('identity_document','selfie','proof_of_address')),
 side text not null check(side in ('front','back','single','none')),
 mime text not null check(mime in ('image/jpeg','image/png','application/pdf')),
 size_bytes integer not null check(size_bytes between 1 and 5242880),
 sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
 fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
 provider_document_id text,
 state text not null check(state in ('declaring','uploading','pending_confirmation','received','rejected','uncertain')),
 environment text not null default 'test' check(environment='test'),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(customer_id,request_id),
 unique(customer_id,doc_type,side,sha256),
 check((doc_type='identity_document' and side in ('front','back','single')) or (doc_type<>'identity_document' and side='none'))
);
create unique index peragus_document_active_slot on peragus_customer_document_uploads(customer_id,doc_type,side)
 where state in ('declaring','uploading','pending_confirmation','uncertain');
alter table peragus_customer_document_uploads enable row level security;
revoke all on peragus_customer_document_uploads from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on peragus_customer_document_uploads from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on peragus_customer_document_uploads from authenticated; end if;
end $$;
