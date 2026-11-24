create table public.commercial_leads (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (char_length(full_name) between 2 and 120),
  corporate_email text not null check (char_length(corporate_email) between 3 and 254),
  company text not null check (char_length(company) between 2 and 160),
  position text not null check (char_length(position) between 2 and 120),
  country text not null check (char_length(country) between 2 and 100),
  company_website text check (char_length(company_website) <= 300),
  area_of_interest text not null check (area_of_interest in (
    'Cross-Border Payments', 'Payment Infrastructure', 'Liquidity Provider Partnership',
    'Fintech Integration', 'Strategic Partnership', 'Other'
  )),
  source text not null default 'homepage' check (source = 'homepage'),
  status text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (corporate_email, area_of_interest)
);

alter table public.commercial_leads enable row level security;
revoke all on public.commercial_leads from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.commercial_leads from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.commercial_leads from authenticated;
  end if;
end $$;
