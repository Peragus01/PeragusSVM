import { useState } from "react";
import { ChevronRight, Code2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "./CopyButton";
import { useConnection } from "./connection-context";

const endpoints = [
  {
    method: "GET",
    path: "/health",
    name: "Backend health",
    description:
      "Proves the backend is online. The UI shows a green state only after this succeeds.",
    schema:
      'type HealthResponse = {\n  status: "ok";\n  service: "peragus-backend";\n  version: string;\n  timestamp: string;\n  uptimeSeconds: number;\n};',
  },
  {
    method: "POST",
    path: "/v1/settlements",
    name: "Create settlement",
    description:
      "Idempotent by request_id: 201 when created, 200 on an identical replay, 409 IDEMPOTENCY_CONFLICT when the payload differs.",
    body: {
      request_id: "acq-0001",
      corridor_id: "<64 hex characters>",
      payer_wallet: "<payer public key>",
      recipient_wallet: "<recipient public key>",
      source_amount: "500000000",
      destination_amount: "89550000",
      expires_at: "2026-10-11T15:00:00.000Z",
    },
    schema:
      "type CreateSettlementRequest = {\n  request_id: string;        // 1-128 chars A-Z a-z 0-9 . _ : -\n  corridor_id: string;       // 64 hex characters\n  payer_wallet: string;      // base58 public key\n  recipient_wallet: string;  // base58 public key\n  source_amount: string;     // positive u64 base units\n  destination_amount: string;// positive u64 base units\n  expires_at: string;        // future ISO-8601\n};\ntype CreateSettlementResponse = {\n  data: Settlement;\n  meta: { idempotent_replay: boolean };\n};",
  },
  {
    method: "GET",
    path: "/v1/settlements/:id",
    name: "Read settlement",
    description: "Canonical status polling route. 404 SETTLEMENT_NOT_FOUND when absent.",
    schema:
      'type SettlementStatus =\n  | "created" | "awaiting_pix" | "pix_confirmed" | "tokenized"\n  | "settling" | "settled" | "offramping" | "paid_out"\n  | "failed" | "revoked";\ntype GetSettlementResponse = { data: Settlement };',
  },
  {
    method: "GET",
    path: "/v1/settlements/:id/onramp",
    name: "On-ramp readiness",
    description:
      "202 while processing, 200 when ready. Payment codes and QR payloads are never displayed.",
    schema:
      'type Onramp = {\n  settlement_status: SettlementStatus;\n  stage: "queued" | "quote_created" | "transfer_created" | "ready";\n  ready: boolean;\n  pix: { expires_at: string; expired: boolean /* payload omitted */ } | null;\n};',
  },
  {
    method: "POST",
    path: "/v1/settlements/:id/solana/prepare",
    name: "Prepare atomic transaction",
    description:
      "Only when tokenized. Returns a co-signed legacy transaction the acquirer verifies, signs, and broadcasts.",
    schema:
      "type PreparedSettlement = {\n  settlement_pda: string;\n  transaction_base64: string;\n  message_hash: string; // sha256 hex of message\n  fee_payer: string;\n  required_external_signer: string;\n  recent_blockhash: string;\n  last_valid_block_height: number;\n};",
  },
  {
    method: "POST",
    path: "/v1/settlements/:id/solana/rollback-demo/prepare",
    name: "Prepare rollback proof",
    description:
      "Sandbox and Devnet only. Returns a co-signed transaction designed to fail on leg B so the UI can verify the atomic rollback before normal settlement.",
    schema:
      'type PreparedRollbackDemo = PreparedSettlement & {\n  scenario: "second_leg_insufficient_liquidity";\n  injected_destination_amount: string;\n  available_destination_balance: string;\n  token_accounts: Record<string, string>;\n};\n// Expected result: failed transaction, unchanged token balances, absent settlement PDA.',
  },
  {
    method: "POST",
    path: "/v1/settlements/:id/solana/confirm",
    name: "Persist verified confirmation",
    description:
      "Call only after Devnet confirmation. The backend verifies the signature on-chain.",
    body: { signature: "<base58 transaction signature>" },
    schema:
      "type ConfirmedSettlement = {\n  settlement_pda: string;\n  signature: string;\n  slot: number;\n  status: SettlementStatus;\n};\n// meta: { verified_on_chain: true }",
  },
  {
    method: "POST",
    path: "/v1/settlements/:id/offramp",
    name: "Initiate payout",
    description:
      "Only after settled. 202 while reconciling; completion is observed by polling, not inferred.",
    body: { payout_destination_id: "<opaque sandbox destination id>" },
    schema:
      "type InitiateOfframpRequest = { payout_destination_id: string };\ntype Offramp = {\n  settlement_status: SettlementStatus;\n  provider_status: string;\n  amounts: { source: Money; quoted_target: Money; transfer_target: Money };\n};",
  },
  {
    method: "GET",
    path: "/v1/settlements/:id/audit",
    name: "Sanitized audit evidence",
    description:
      "Event hashes, reserve outcome, verified Solana signatures, and completeness checks. No payment instructions.",
    schema:
      'type SettlementAudit = {\n  contingency_reserve: {\n    status: "funded" | "settled" | "refunded";\n    reserve_pda: string;\n    resolution_signature: string | null;\n  } | null;\n  solana_settlement: { atomic_signature: string | null; verified: boolean } | null;\n  checks: { evidence_complete: boolean; /* ... */ };\n  warnings: string[];\n};',
  },
];

export function ApiReference() {
  const { base } = useConnection();
  const [selected, setSelected] = useState(1);
  const [language, setLanguage] = useState<"curl" | "typescript">("curl");
  const endpoint = endpoints[selected] ?? endpoints[0];
  if (!endpoint) return null;
  const url = `${base}${endpoint.path.replace(":id", "${SETTLEMENT_ID}")}`;
  const sample =
    language === "typescript"
      ? endpoint.schema
      : `curl --request ${endpoint.method} '${url}' \\\n  --header 'Accept: application/json'${endpoint.body ? ` \\\n  --header 'Content-Type: application/json' \\\n  --data '${JSON.stringify(endpoint.body, null, 2)}'` : ""}`;
  return (
    <div className="api-page">
      <div className="section-heading">
        <div>
          <div className="eyebrow">API CONTRACT</div>
          <h1>
            One API. The entire settlement lifecycle<span className="heading-dot">.</span>
          </h1>
          <p className="page-subtitle">
            Success payloads use <code>{"{ data, meta }"}</code>; errors use{" "}
            <code>{"{ error: { code, message, retryable } }"}</code>. Base URL: <code>{base}</code>.
          </p>
        </div>
        <Code2 className="page-symbol" />
      </div>
      <div className="api-workspace">
        <nav className="endpoint-nav" aria-label="API endpoints">
          {endpoints.map((item, i) => (
            <Button
              variant="ghost"
              key={item.path + item.method}
              onClick={() => setSelected(i)}
              className={`endpoint-button ${selected === i ? "active" : ""}`}
            >
              <span className={`method-badge ${item.method.toLowerCase()}`}>{item.method}</span>
              <span>{item.path}</span>
              <ChevronRight />
            </Button>
          ))}
        </nav>
        <section className="endpoint-detail">
          <div className="flex items-center gap-3">
            <span className={`method-badge ${endpoint.method.toLowerCase()}`}>
              {endpoint.method}
            </span>
            <code className="text-xs break-all">{endpoint.path}</code>
          </div>
          <h2>{endpoint.name}</h2>
          <p>{endpoint.description}</p>
          <div className="code-toolbar">
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                className={language === "curl" ? "code-tab-active" : ""}
                onClick={() => setLanguage("curl")}
              >
                cURL
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={language === "typescript" ? "code-tab-active" : ""}
                onClick={() => setLanguage("typescript")}
              >
                TypeScript
              </Button>
            </div>
            <CopyButton value={sample} label="Copy API example" />
          </div>
          <pre className="api-code">{sample}</pre>
        </section>
      </div>
    </div>
  );
}
