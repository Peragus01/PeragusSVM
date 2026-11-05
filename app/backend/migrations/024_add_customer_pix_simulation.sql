-- Durable one-shot sandbox pay-in simulation. Never reset after an uncertain POST.
alter table peragus_customer_sandbox_pix
 add column simulation_attempted boolean not null default false,
 add column simulation_attempted_at timestamptz,
 add constraint peragus_pix_simulation_claim_check check(
  (not simulation_attempted and simulation_attempted_at is null) or
  (simulation_attempted and simulation_attempted_at is not null and create_attempted and provider_transfer_id is not null)
 );
