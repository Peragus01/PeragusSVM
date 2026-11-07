# Registration receipt and email status

After confirmed linked submission, show a customer-facing receipt. Accepted terms alone do not imply completed submission, identity capture or approval. The backend GET /v1/me/onboarding/status supplies review_state and own-account email_notifications.enabled.

The page distinguishes pending identity capture, action required, review, approved-in-test and rejection. Only an operational, allowlisted notification service enables the email promise. Missing backend extension or status errors fall back to tracking in Minha conta without promising email. Sandbox document-capture limitations remain explicit, with technical explanations collapsed. Existing verification/screening actions and financial gates remain intact.

Deploy the companion backend notification PR and migration before enabling the dedicated Resend worker. See app/backend/docs/integration/onboarding-email-notifications.md for variables, sender requirements, allowlist, 23-hour uncertain-send cutoff, and staging acceptance. No frontend secret or new financial flag is required.

Existing OZAV term acceptance is reused. No new Peragus legal terms, signature or consent record is invented. A separate versioned Peragus terms contract and approved text must be supplied before claiming that both contracts were signed.

Synthetic validation: frontend TypeScript/build, 116 tests including receipt states and interrupted-onboarding regression; no real emails, Auth signups, documents or payments executed. Browser/mobile visual acceptance remains required in staging; this environment has no installed Chromium executable.
