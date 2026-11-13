import { forwardCustomerRead } from "./customer-proxy.server";
import { forwardJsonWrite } from "./refund-proxy.server";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Only what the console screens call (audit and the approval GET stay closed).
const exact: Record<string, string[]> = {
  "v1/admin/operator-status": ["GET"],
  "v1/admin/runtime-controls": ["GET", "PUT"],
  "v1/admin/daily-reviews": ["GET", "POST"],
  "v1/admin/operational-alerts": ["GET"],
  "v1/admin/operator-notifications": ["GET"],
  "v1/admin/withdrawal-requests": ["GET"],
};
const withdrawal = (suffix: string) =>
  new RegExp(`^v1/admin/withdrawal-requests/${uuid}/${suffix}$`, "i");
const approval = withdrawal("approval");
const execution = withdrawal("execution");
const reconcile = withdrawal("execution/reconcile");

/** Operator console resources (allowlist + AAL2 enforced by the backend). Refunds live in refund-proxy. */
export function operatorMethods(path: string): string[] {
  if (Object.hasOwn(exact, path)) return exact[path]!;
  if (execution.test(path)) return ["GET", "POST"];
  if (approval.test(path) || reconcile.test(path)) return ["POST"];
  return [];
}
const error = (status: number, code: string) =>
  Response.json(
    { error: { code } },
    { status, headers: { "Cache-Control": "no-store", Vary: "Authorization" } },
  );
export async function forwardOperator(request: Request, target: URL, path: string) {
  const methods = operatorMethods(path);
  if (!methods.length) return error(404, "NOT_FOUND");
  if (!methods.includes(request.method)) {
    const response = error(405, "METHOD_NOT_ALLOWED");
    response.headers.set("Allow", methods.join(", "));
    return response;
  }
  if (request.method === "GET") return forwardCustomerRead(request, target);
  // The reconcile POST carries no body (the backend refuses one).
  return forwardJsonWrite(request, target, { emptyBody: reconcile.test(path) });
}
