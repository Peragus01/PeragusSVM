import { read, CustomerReadError } from "./customer-reads";
export interface OnboardingStatus {
  customer: { id: string };
  environment: "test";
  sandbox_only: true;
  source: "stored_observations";
  observation_freshness: "not_evaluated";
  operations_enabled: false;
  registration: { provider_status: string | null } | null;
  identity: { identity_outcome: "approved" | "rejected" | null } | null;
  screening: { status: string | null; result: string | null } | null;
  pending_steps: string[];
}
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const nullableText = (v: unknown) => v === null || typeof v === "string";
export async function getOnboardingStatus(
  token: string,
  customerId: string,
  signal?: AbortSignal,
): Promise<OnboardingStatus> {
  const body = await read("/v1/me/onboarding/status", token, signal);
  const d = record(body) ? body["data"] : null;
  if (
    !record(d) ||
    !record(d["customer"]) ||
    d["customer"]["id"] !== customerId ||
    d["environment"] !== "test" ||
    d["sandbox_only"] !== true ||
    d["source"] !== "stored_observations" ||
    d["observation_freshness"] !== "not_evaluated" ||
    d["operations_enabled"] !== false ||
    !Array.isArray(d["pending_steps"]) ||
    !d["pending_steps"].every((x) => typeof x === "string") ||
    !(
      d["registration"] === null ||
      (record(d["registration"]) &&
        (d["registration"]["provider_status"] === null ||
          typeof d["registration"]["provider_status"] === "string"))
    ) ||
    !(
      d["identity"] === null ||
      (record(d["identity"]) &&
        (d["identity"]["identity_outcome"] === null ||
          d["identity"]["identity_outcome"] === "approved" ||
          d["identity"]["identity_outcome"] === "rejected"))
    ) ||
    !(
      d["screening"] === null ||
      (record(d["screening"]) &&
        nullableText(d["screening"]["status"]) &&
        nullableText(d["screening"]["result"]))
    )
  )
    throw new CustomerReadError("INVALID_RESPONSE", 502);
  return d as unknown as OnboardingStatus;
}
export function evidenceLabels(d: OnboardingStatus) {
  return {
    provider:
      d.registration?.provider_status === "approved" ? "Aprovado (sandbox)" : "Não confirmado",
    identity:
      d.identity?.identity_outcome === "approved"
        ? "Aprovada (sandbox)"
        : d.identity?.identity_outcome === "rejected"
          ? "Rejeitada (sandbox)"
          : "Não confirmada",
    screening:
      d.screening?.status === "completed" && d.screening.result === "clear"
        ? "Concluído · sem apontamentos"
        : "Não confirmado como concluído e clear",
  };
}
