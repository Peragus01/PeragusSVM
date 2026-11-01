# Welcome email — staging rollout

## Current state
- Branch: feat/welcome-email-staging; do not merge before staging validation.
- Supabase staging: lybdkqkbwlfwvmmvstzi.
- Auth trigger: internal.enqueue_confirmed_welcome, on INSERT/UPDATE of auth.users.email_confirmed_at.
- Queue: internal.welcome_email_outbox (service-only).
- RPCs: public.claim_welcome_email / public.finish_welcome_email, EXECUTE service_role only.
- Edge Function: process-welcome-email, JWT verification enabled. Must be invoked with service-role JWT by a trusted scheduled backend (never from browser).
- Template: peragus-boas-vindas in Resend.

## Configuration still required
1. Verify domain in the same Resend account and set RESEND_API_KEY, RESEND_FROM in staging Edge Function secrets. Never expose the key in frontend or repository.
2. Upload the original PNG to a public HTTPS asset host; verify 200 image/png, then replace the template's placeholder logo URL and republish. Do not assume the placeholder exists.
3. Configure a trusted scheduled caller, e.g. an existing backend scheduler, to POST process-welcome-email with service-role JWT; no client access. At least once per minute is appropriate for the MVP, subject to deployment support.
4. Validate a controlled account with normal email confirmation, retry and duplicate tests, dark/light email client rendering, and Resend delivery records.

## Important limitations
- This version processes one queued message per invocation.
- Resend idempotency is an additional safeguard but may have a provider retention window; indefinite exactly-once delivery cannot be guaranteed after a crash between API acceptance and database acknowledgement.
- Queue retries stop after 5 attempts and need manual review.
- No production configuration changes are authorized.
- Do not use Supabase Send Email Hook for onboarding; it replaces transactional Auth emails and must remain separate from confirmation.
