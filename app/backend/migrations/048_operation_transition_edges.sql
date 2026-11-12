-- Adds accepted -> needs_review: a live Pix whose create was ambiguous (timeout,
-- reduced response or refresh conflict) is recovered by GET, but the FX lock
-- outcome exists only on the create response, so an operator must decide.
-- Mirrors canTransition in src/purchases/operation-status.ts (a test compares
-- every pair). CREATE OR REPLACE keeps the privileges revoked by 045.
create or replace function peragus_operation_can_transition(from_status text, to_status text) returns boolean
 language sql immutable set search_path = pg_catalog, public as $$
 select exists(select 1 from (values
  ('quoted','accepted'),('quoted','expired'),
  ('accepted','awaiting_pix'),('accepted','expired'),('accepted','failed'),('accepted','needs_review'),
  ('awaiting_pix','pix_confirmed'),('awaiting_pix','converted'),('awaiting_pix','expired'),('awaiting_pix','failed'),
  ('awaiting_pix','needs_review'),('awaiting_pix','refund_pending'),
  ('pix_confirmed','converted'),('pix_confirmed','needs_review'),('pix_confirmed','refund_pending'),
  ('converted','awaiting_approval'),('converted','needs_review'),('converted','refund_pending'),
  ('awaiting_approval','approved'),('awaiting_approval','needs_review'),('awaiting_approval','refund_pending'),
  ('approved','sending'),('approved','needs_review'),
  ('sending','sent'),('sending','needs_review'),
  ('sent','delivered_verified'),('sent','needs_review'),
  ('needs_review','awaiting_approval'),('needs_review','refund_pending'),('needs_review','failed'),
  ('refund_pending','refunded'),('refund_pending','needs_review')
 ) t(f,t) where t.f=from_status and t.t=to_status)
$$;
