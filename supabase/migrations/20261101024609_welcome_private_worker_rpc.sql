create or replace function public.claim_welcome_email() returns table(user_id uuid,recipient_email text,first_name text)
language plpgsql security definer set search_path='' as $$
begin
  return query with selected as (
    select q.user_id from internal.welcome_email_outbox q
    where (q.state in ('pending','failed') and q.next_attempt_at <= now() and q.attempts < 5)
       or (q.state='processing' and q.claimed_at < now()-interval '10 minutes' and q.attempts < 5)
    order by q.created_at for update skip locked limit 1
  )
  update internal.welcome_email_outbox q
  set state='processing',attempts=q.attempts+1,claimed_at=now()
  from selected s where q.user_id=s.user_id
  returning q.user_id,q.recipient_email,q.first_name;
end; $$;
revoke all on function public.claim_welcome_email() from public,anon,authenticated;
grant execute on function public.claim_welcome_email() to service_role;
create or replace function public.finish_welcome_email(p_user_id uuid,p_success boolean,p_provider_id text default null,p_error text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 update internal.welcome_email_outbox
 set state=case when p_success then 'sent' else 'failed' end,
     sent_at=case when p_success then now() else sent_at end,
     provider_id=case when p_success then left(p_provider_id,120) else provider_id end,
     last_error=case when p_success then null else left(p_error,300) end,
     next_attempt_at=case when p_success then next_attempt_at else now()+make_interval(mins => least(60,cast(power(2,least(attempts,5)) as int))) end,
     claimed_at=null
 where user_id=p_user_id and state='processing';
end; $$;
revoke all on function public.finish_welcome_email(uuid,boolean,text,text) from public,anon,authenticated;
grant execute on function public.finish_welcome_email(uuid,boolean,text,text) to service_role;
