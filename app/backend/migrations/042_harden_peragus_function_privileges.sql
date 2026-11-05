-- Event-trigger execution does not require grants to browser roles.
do $$ declare r text; begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public;
    for r in select rolname from pg_roles where rolname in ('anon','authenticated') loop
      execute format('revoke execute on function public.rls_auto_enable() from %I',r);
    end loop;
  end if;
end $$;
-- Only application-owned trigger functions; never change pg-boss or extensions.
do $$ declare f record; r text; begin
  for f in select p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'peragus\_%' escape '\'
      and p.prorettype='trigger'::regtype
  loop
    execute format('alter function %s set search_path = pg_catalog, public', f.signature);
    execute format('revoke execute on function %s from public', f.signature);
    for r in select rolname from pg_roles where rolname in ('anon','authenticated') loop
      execute format('revoke execute on function %s from %I',f.signature,r);
    end loop;
  end loop;
end $$;
