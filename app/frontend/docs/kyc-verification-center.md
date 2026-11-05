# Personal verification center

Reference: the official MEXC primary/advanced KYC guides, inspected 2026-11-05:
- https://www.mexc.com/announcements/article/how-to-complete-primary-kyc-verification-17827791519718
- https://www.mexc.com/announcements/article/how-to-complete-advanced-kyc-verification-360041069032

The design borrows the guided verification entry point and stage hierarchy. It uses Peragus branding and the existing OZAV requirements; it does not import MEXC trading tiers, document eligibility, review deadlines, financial limits, camera flows or approval assumptions.

The document page now shows personal-data, document and identity-review cards before presenting upload controls. DOCUMENT_CUSTOMER_REQUIRED is an expected prerequisite state with a primary link to the account form, not a generic failed-upload alert. Unknown/unavailable data remains distinct and cannot activate upload controls. A successful requirements query establishes only the linked-profile prerequisite; receipt counts remain separate from identity approval.

The account form is divided into personal information, address and profile/source-of-funds sections. All fields remain mounted, preserving server field errors, focus, values, request payloads and concurrency protection. The existing synthetic-file confirmation, private metadata, exact-request receipt recovery and duplicate-upload guards remain unchanged.

Validation runs through GitHub CI because the interactive execution environment was unavailable. Added regressions cover prerequisite guidance, action destinations, unavailable provider data and field grouping, alongside the existing validation and document tests. No migration, backend change, financial flag or provider operation is introduced.
