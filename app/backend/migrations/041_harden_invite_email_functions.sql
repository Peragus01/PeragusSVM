-- Keep trigger name resolution fixed; preserve migration 040's recorded checksum.
alter function public.peragus_cancel_invite_email() set search_path = pg_catalog, public;
alter function public.peragus_guard_invite_email() set search_path = pg_catalog, public;
