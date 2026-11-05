-- Pre-registration invitations reuse the existing five admission slots and atomic redemption.
alter table peragus_pilot_invites alter column target_user_id drop not null;
alter table peragus_pilot_invites add column target_email_hash text check(target_email_hash ~ '^[a-f0-9]{64}$');
alter table peragus_pilot_invites add constraint invite_target_required check(target_user_id is not null or target_email_hash is not null);
alter table peragus_pilot_invites add constraint redeemed_target_bound check(state<>'redeemed' or (target_user_id is not null and target_user_id=redeemed_by));
create unique index peragus_one_active_invite_per_email on peragus_pilot_invites(target_email_hash) where state in ('issued','redeemed') and target_email_hash is not null;
alter table peragus_pilot_invite_rate_limits drop constraint peragus_pilot_invite_rate_limits_action_check;
alter table peragus_pilot_invite_rate_limits add constraint peragus_pilot_invite_rate_limits_action_check check(action in ('issue','redeem','revoke','validate'));
create or replace function peragus_guard_pilot_invite() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'pilot invite audit cannot be deleted'; end if;
 if (new.id,new.slot,new.code_hash,new.target_email_hash,new.operator_user_id,new.request_id,new.reason,new.duration_hours,new.created_at,new.expires_at,new.environment)
  is distinct from (old.id,old.slot,old.code_hash,old.target_email_hash,old.operator_user_id,old.request_id,old.reason,old.duration_hours,old.created_at,old.expires_at,old.environment)
  or (new.target_user_id is distinct from old.target_user_id and not(old.target_user_id is null and old.target_email_hash is not null and new.state='redeemed' and new.target_user_id=new.redeemed_by))
  or old.state<>'issued' or new.state not in ('redeemed','revoked','expired') then
  raise exception 'pilot invite audit is immutable except for a single terminal transition';
 end if;
 return new;
end $$;
