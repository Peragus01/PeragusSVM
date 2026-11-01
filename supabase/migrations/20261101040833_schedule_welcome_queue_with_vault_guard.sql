create or replace function internal.dispatch_welcome_queue() returns void language plpgsql security invoker set search_path = '' as $$
declare token text;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name = 'peragus_welcome_scheduler_service_key' limit 1;
  if token is null or length(token) < 20 then return; end if;
  perform net.http_post(
    url := 'https://lybdkqkbwlfwvmmvstzi.supabase.co/functions/v1/process-welcome-email',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || token),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
end $$;
revoke all on function internal.dispatch_welcome_queue() from public, anon, authenticated;
select cron.schedule('peragus-welcome-email-staging', '* * * * *', 'select internal.dispatch_welcome_queue();');
