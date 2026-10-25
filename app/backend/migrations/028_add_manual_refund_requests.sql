-- Manual case tracking only. No refund provider request or automatic movement.
create table peragus_customer_refund_requests (
 id uuid primary key,
 customer_id uuid not null,
 purchase_intent_id uuid not null unique,
 pix_id uuid not null unique,
 request_id uuid not null,
 reason varchar(500) not null check(length(trim(reason))>=10 and reason !~ '[[:cntrl:]]'),
 amount_brl numeric(21,2) not null check(amount_brl>0),
 environment text not null default 'test' check(environment='test'),
 created_at timestamptz not null default now(),
 unique(customer_id,request_id),
 unique(id,customer_id,amount_brl),
 unique(id,customer_id),
 foreign key(pix_id,purchase_intent_id,customer_id) references peragus_customer_sandbox_pix(id,purchase_intent_id,customer_id)
);
create table peragus_manual_refund_decisions (
 id uuid primary key,
 refund_request_id uuid not null unique,
 customer_id uuid not null,
 operator_user_id uuid not null,
 request_id uuid not null,
 decision text not null check(decision in ('approved','rejected')),
 reason varchar(300) not null check(length(trim(reason))>=10 and reason !~ '[[:cntrl:]]'),
 assurance_level text not null default 'aal2' check(assurance_level='aal2'),
 created_at timestamptz not null default now(),
 unique(operator_user_id,request_id),
 unique(id,refund_request_id,customer_id,decision),
 foreign key(refund_request_id,customer_id) references peragus_customer_refund_requests(id,customer_id)
);
create table peragus_manual_refund_completions (
 id uuid primary key,
 refund_request_id uuid not null unique,
 customer_id uuid not null,
 decision_id uuid not null,
 decision text not null default 'approved' check(decision='approved'),
 operator_user_id uuid not null,
 request_id uuid not null,
 maximum_amount_brl numeric(21,2) not null,
 amount_brl numeric(21,2) not null check(amount_brl>0 and amount_brl<=maximum_amount_brl),
 reference varchar(160) not null check(length(trim(reference))>=8 and reference !~ '[[:cntrl:]]'),
 assurance_level text not null default 'aal2' check(assurance_level='aal2'),
 created_at timestamptz not null default now(),
 unique(operator_user_id,request_id),
 foreign key(refund_request_id,customer_id,maximum_amount_brl) references peragus_customer_refund_requests(id,customer_id,amount_brl),
 foreign key(decision_id,refund_request_id,customer_id,decision) references peragus_manual_refund_decisions(id,refund_request_id,customer_id,decision)
);
create index peragus_refund_customer_history on peragus_customer_refund_requests(customer_id,created_at desc,id desc);
create function peragus_reject_manual_refund_mutation() returns trigger language plpgsql as $$
begin raise exception 'Manual refund evidence is append-only'; end;
$$;
do $$ declare t text; begin
 foreach t in array array['peragus_customer_refund_requests','peragus_manual_refund_decisions','peragus_manual_refund_completions'] loop
  execute format('alter table %I enable row level security',t);
  execute format('revoke all on %I from public',t);
  if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on %I from anon',t); end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then execute format('revoke all on %I from authenticated',t); end if;
  execute format('create trigger manual_refund_immutable before update or delete on %I for each row execute function peragus_reject_manual_refund_mutation()',t);
 end loop;
end $$;
