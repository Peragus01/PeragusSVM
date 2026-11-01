-- Expand invite capacity on demand while preserving existing admissions and audit history.
-- No automatic public registration: operator auth, MFA, idempotency and rate limits remain required.
alter table public.peragus_pilot_invite_slots drop constraint if exists peragus_pilot_invite_slots_slot_check;
alter table public.peragus_pilot_invites drop constraint if exists peragus_pilot_invites_slot_fkey;
alter table public.peragus_pilot_invite_slots alter column slot type integer;
alter table public.peragus_pilot_invites alter column slot type integer;
alter table public.peragus_pilot_invites add constraint peragus_pilot_invites_slot_fkey
  foreign key (slot) references public.peragus_pilot_invite_slots(slot);
create sequence if not exists public.peragus_pilot_invite_slot_sequence as integer;
select setval('public.peragus_pilot_invite_slot_sequence',
  greatest(5, coalesce((select max(slot) from public.peragus_pilot_invite_slots),0)), true);
revoke all on sequence public.peragus_pilot_invite_slot_sequence from public;
do $ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    revoke all on sequence public.peragus_pilot_invite_slot_sequence from anon;
  end if;
  if exists(select 1 from pg_roles where rolname='authenticated') then
    revoke all on sequence public.peragus_pilot_invite_slot_sequence from authenticated;
  end if;
end $;
