# Legal documents and signup gate (staging-only draft)

Scope: only three documents (Peragus Terms of Use, Privacy Policy, improved Refund Policy) and the two acknowledgements on `/cadastro`. Existing OZAV terms/KYC and payment flows are unchanged.

- Both checkboxes start unchecked and the Create Account button stays disabled until both are checked.
- The privacy acknowledgement records **awareness of the policy**, not blanket LGPD consent.
- The first-party signup endpoint checks both flags and **exact** document versions, revalidates the invitation, then forwards the ordinary email/password signup to Supabase Auth.
- No passwords or acceptance objects are logged or returned. These drafts use `noindex` and an explicit review banner.
- **Critical limitation:** Supabase Auth's public signup endpoint remains callable directly while public signup is enabled. The first-party server endpoint prevents bypass through this website, **but does not guarantee universal account-creation enforcement**. For strict enforcement, a validated Supabase Auth *Before User Created* hook or equivalent independent signup restriction is required before production. Do not enable the hook in production without staging acceptance tests.
- The current signup flow does not create immutable, server-verified acceptance evidence linked to the Auth user. Final legal versions and evidence/retention requirements require legal approval.
- Before production: verify legal claims (OZAV identity/regulatory status, retention, data subprocessors), the refund execution mechanism, and the public address; approve final versions, remove draft/noindex banners, and implement an Auth-side enforcement mechanism. Do not merge as production legal text until reviewed.

Checks to run: `cd app/frontend && npm ci && npm run typecheck && npm test && npm run build`. Manual: two empty checkboxes => disabled; either checked alone => disabled; both => enabled; both documents open; authenticated invitation redemption and OZAV KYC unchanged.
