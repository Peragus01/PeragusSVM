-- Five admission slots. Existing PF profiles occupy slots; no customer is deleted.
create table peragus_pilot_invite_slots (
 slot smallint primary key check(slot between 1 and 5),
 current_invite_id uuid unique,
 admitted_user_id uuid unique references peragus_customers(owner_user_id)
);
insert into peragus_pilot_invite_slots(slot) select generate_series(1,5);
with existing as (
 select owner_user_id,row_number() over(order by created_at,id) as slot from peragus_customers where customer_type='pf'
) update peragus_pilot_invite_slots s set admitted_user_id=e.owner_user_id from existing e where e.slot=s.slot;
create table peragus_pilot_invites (
 id uuid primary key,
 slot smallint not null references peragus_pilot_invite_slots(slot),
 target_user_id uuid not null,
 code_hash text not null unique check(code_hash ~ '^[0-9a-f]{64}$'),
 operator_user_id uuid not null,
 request_id uuid not null,
 reason varchar(300) not null check(length(trim(reason))>=10 and reason !~ '[[:cntrl:]]'),
 duration_hours integer not null check(duration_hours between 1 and 168),
 state text not null default 'issued' check(state in ('issued','redeemed','revoked','expired')),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null,
 redeemed_by uuid references peragus_customers(owner_user_id),
 redemption_request_id uuid,
 redeemed_at timestamptz,
 revoked_by uuid,
 revocation_request_id uuid,
 revocation_reason varchar(300),
 revoked_at timestamptz,
 environment text not null default 'test' check(environment='test'),
 unique(operator_user_id,request_id),
 check(expires_at>created_at),
 check((state='redeemed')=(redeemed_by is not null)),
 check((state='redeemed')=(redemption_request_id is not null)),
 check((state='redeemed')=(redeemed_at is not null)),
 check(redeemed_by is null or redeemed_by=target_user_id),
 check((state='revoked')=(revoked_by is not null)),
 check((state='revoked')=(revocation_request_id is not null)),
 check((state='revoked')=(revoked_at is not null)),
 check((state='revoked')=(revocation_reason is not null)),
 check(revocation_reason is null or (length(trim(revocation_reason))>=10 and revocation_reason !~ '[[:cntrl:]]'))
);
create unique index peragus_one_active_invite_per_user on peragus_pilot_invites(target_user_id) where state in ('issued','redeemed');
create unique index peragus_invite_redemption_key on peragus_pilot_invites(redeemed_by,redemption_request_id) where redeemed_by is not null;
create unique index peragus_invite_revocation_key on peragus_pilot_invites(revoked_by,revocation_request_id) where revoked_by is not null;
alter table peragus_pilot_invite_slots add constraint peragus_slot_invite_fk foreign key(current_invite_id) references peragus_pilot_invites(id) deferrable initially deferred;
create function peragus_guard_pilot_invite() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'pilot invite audit cannot be deleted'; end if;
 if (new.id,new.slot,new.target_user_id,new.code_hash,new.operator_user_id,new.request_id,new.reason,new.duration_hours,new.created_at,new.expires_at,new.environment)
  is distinct from (old.id,old.slot,old.target_user_id,old.code_hash,old.operator_user_id,old.request_id,old.reason,old.duration_hours,old.created_at,old.expires_at,old.environment)
  or old.state<>'issued' or new.state not in ('redeemed','revoked','expired') then
  raise exception 'pilot invite audit is immutable except for a single terminal transition';
 end if;
 return new;
end $$;
create trigger peragus_pilot_invite_guard before update or delete on peragus_pilot_invites for each row execute function peragus_guard_pilot_invite();
alter table peragus_pilot_invite_slots enable row level security;
alter table peragus_pilot_invites enable row level security;
revoke all on peragus_pilot_invite_slots,peragus_pilot_invites from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on peragus_pilot_invite_slots,peragus_pilot_invites from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on peragus_pilot_invite_slots,peragus_pilot_invites from authenticated; end if;
end $$;

create table peragus_pilot_invite_rate_limits (
 actor_user_id uuid not null,
 action text not null check(action in ('issue','redeem','revoke')),
 window_start timestamptz not null default now(),
 hits smallint not null check(hits between 1 and 11),
 primary key(actor_user_id,action)
);
alter table peragus_pilot_invite_rate_limits enable row level security;
revoke all on peragus_pilot_invite_rate_limits from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then revoke all on peragus_pilot_invite_rate_limits from anon; end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then revoke all on peragus_pilot_invite_rate_limits from authenticated; end if;
end $$;
