-- Submission attestation (Task 15). Not applied to any environment before this version.
--
-- Records what the person confirmed with the registration request: in test, that the
-- data are synthetic (sandbox_data_confirmed); in live, that the data are their own and
-- true (data_truthfulness_confirmed). The value must match the row's environment.
-- Rows created before this version keep a null attestation; the service requires one
-- for every new live submission.
alter table peragus_customer_onboarding_submissions
 add column attestation text check(attestation in ('sandbox_data_confirmed','data_truthfulness_confirmed')),
 add column attested_at timestamptz,
 add constraint peragus_onboarding_submission_attestation_check check(
  (attestation is null and attested_at is null)
  or (attested_at is not null and attestation = case environment when 'live' then 'data_truthfulness_confirmed' else 'sandbox_data_confirmed' end)
 );
