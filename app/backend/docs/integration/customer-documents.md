# Private PF document upload backend

## Scope

Implements the document-upload mechanics from the official OZAV v2 contract, inspected 2026-11-02 at https://developers.ozav.io/openapi.json: POST/GET /customers/{customer_id}/documents, CustomerDocumentUploadRequest, CustomerDocumentUpload and CustomerDocument. No provider write, live credential, real document, paid operation or financial call was used during implementation. Frontend controls and proxy integration are a separate change.

This first executable integration is disabled by default and pinned to the existing test Auth/database and test capabilities. It is not a switch to production KYC. Existing test-only verification adapters, financial guards and custody behavior remain unchanged. A customer's document receipt does not verify identity, screening, account eligibility or any financial operation.

## API

All routes require a verified own PF profile that is not suspended. Authentication happens before body parsing for this scope, and the existing root authentication/authorization and rate limiter remain in force.

| Route | Behavior |
| --- | --- |
| GET /v1/me/onboarding/documents | Latest 50 local upload records owned by the authenticated customer, newest first; no URL, hashes, provider-customer ID, filename or file data returned. |
| GET /v1/me/onboarding/documents/requirements | Provider's global still_required summary; missing field is null/unknown, explicit empty list stays empty. Supported upload categories are labeled; unsupported requirements remain visible and never become satisfied automatically. No free-text provider reasons are exposed. |
| POST /v1/me/onboarding/documents | Raw bytes, not multipart or JSON/base64. Headers: Idempotency-Key (UUID), X-Document-Type, X-Document-Side and Content-Type. |
| GET /v1/me/onboarding/documents/:id | Own local state only. |
| POST /v1/me/onboarding/documents/:id/refresh | Empty body; GET-only provider receipt recovery, never a repeated declaration or PUT. |

Supported document types: identity_document, selfie, proof_of_address. Identity requires explicit front/back/single and declares issuing_country BR for this MVP. Non-identity documents require side none (omitted from provider body). Only JPEG/PNG images are accepted for identity/selfie; proof of address also accepts PDF 1.0–1.7. Limit: 5 MiB per file, two concurrent POSTs per API instance, 20-second body deadline. Header/trailer checks detect obvious MIME spoofing; common active PDF constructs are refused. These checks are not malware scanning, full format decoding, identity authenticity or liveness detection. Unsupported document types/countries and PDF 2.0 require a separate reviewed extension.

All replies use Cache-Control:no-store. Authentication, disabled feature, unsupported MIME, oversized body, conflicts and provider failures fail closed. Private resource IDs return not found for other customers. The browser cannot specify customer/provider IDs, upload URLs, destination hosts or associated persons.

## Durable state and retries

Migration 038 creates a private metadata table with RLS and no anon/authenticated grants. It stores size, SHA-256, MIME, category/side, local request UUID, provider binding and state. No file bytes or signed URL are stored. File bytes exist only in bounded request memory and the handler clears its buffer after processing. Application body logging is redacted.

Before any POST, the service validates bytes, resolves the authenticated customer's linked full-mode submission, checks test customer read/write capabilities, then durably reserves the request fingerprint. Same-key/same-payload replays only return stored state. Changed payloads conflict. Concurrent attempts and identical content cannot silently redeclare the same document. Active category/side slots block replacement until their uncertain/pending state is resolved. Rejected/received documents can be replaced with different bytes under a new key; a rejected identical file remains deduplicated.

Flow: declaring → uploading → pending_confirmation → received/rejected. Any ambiguous declaration/PUT outcome remains uncertain (or a durable earlier state when storage failed). A crash at declaring/uploading is never treated as permission to repeat POST/PUT. The OZAV declaration endpoint has no documented idempotency guarantee here, so the client enforces attempts=1. A declaration timeout without a saved document ID requires manual provider-side investigation; do not create another request or reset its row to force a retry.

After PUT acceptance, the service reads at most five bounded provider pages and requires matching document/customer/type/side, size, MIME and server-computed SHA-256 before declaring receipt. A pending/missing/mismatched response stays unconfirmed. If a provider ID was saved, refresh can reconcile an uncertain PUT through GET only. Receipt is always identity_verified:false and operations_enabled:false. Provider identity approval must still come through the existing verification/screening evidence path.

## Upload transport isolation

The short-lived URL stays server-side. Its origin must exactly match the configured allowlist, use HTTPS without userinfo, custom port or fragment, and have a valid near-term expiry. The server permits exact configured origins https://storage.ozav.io and https://developers.ozav.io. The latter hostname was observed in a sandbox response; successful upload and the provider contract remain unverified. No wildcard origins are permitted. Never broaden to wildcard cloud-storage domains without review.

The uploader resolves IPv4, rejects private/link-local/reserved destinations and pins the checked IP into the TLS request lookup while preserving hostname/certificate validation. For the exact OZAV developers origin and customer/document upload path, PUT includes the test API key as required by the current OZAV contract. Other allowed origins never receive the key; cookies and caller headers are never forwarded. Redirects are not followed; timeouts, interrupted responses and oversized response bodies are unconfirmed. Errors and responses never expose signed URLs or provider error payloads. Platform-level egress tracing must also redact query strings before real-document use.

## Rollout and acceptance

Keep CUSTOMER_DOCUMENTS_ENABLED=false. No environment, database or deployment was changed by this implementation. Apply 038 through the existing checksum migration runner only during authorized staging rollout; do not rename prior migrations. Enabling additionally requires the pinned staging database/Auth, a test OZAV key, existing submission feature, enabled API rate limits, all financial/demo flags off and an explicit CUSTOMER_DOCUMENT_UPLOAD_ORIGINS allowlist. In staging, https://developers.ozav.io was observed but still requires controlled verification. Startup refuses a live key for this feature.

Local synthetic tests cover ownership, disabled/auth/suspension gates, byte limits/MIME, duplicate/concurrent requests, changed payload, uncertain POST/PUT recovery, integrity mismatch, private origins/DNS, no redirect, interrupted upload and credential isolation. No real file has been sent to the provider. An external synthetic sandbox acceptance remains a separate explicit step; it must not be mistaken for real KYC or account-specific live readiness.

Remaining before a live pilot: controlled frontend capture/proxy, appropriate consent/privacy/retention and malware policy, real provider capability/capture validation, required liveness and unsupported-document handling, source/environment-aware identity adapters and a separately approved live rollout. No production key is needed to finish local UI and contract tests.

As of 2026-11-02 the OZAV OpenAPI marks document declaration/list/upload as live availability even though sandbox declaration and list have responded. The current contract requires X-API-Key on the OZAV-hosted signed PUT. Sandbox receipt is unverified and must be established with a controlled synthetic test. Never switch to a live key to bypass a sandbox limitation.
