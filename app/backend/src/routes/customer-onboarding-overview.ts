import type { FastifyInstance } from "fastify";
import type { CustomerOnboardingOverview } from "../onboarding/customer-onboarding-overview.js";
export async function registerCustomerOnboardingOverviewRoute(app: FastifyInstance, service?: CustomerOnboardingOverview) {
  app.get("/v1/me/onboarding/status",async(request,reply)=>{
    reply.header("Cache-Control","no-store");
    if (!request.authenticatedUser) return reply.code(401).send({error:{code:"AUTH_REQUIRED"}});
    if (!service) return reply.code(503).send({error:{code:"CUSTOMER_ONBOARDING_STATUS_DISABLED"}});
    const customer=request.authenticatedCustomer;
    if (!customer || customer.type!=="pf" || customer.suspended) return reply.code(403).send({error:{code:"INDIVIDUAL_PROFILE_REQUIRED"}});
    if (Object.keys(request.query as object).length) return reply.code(400).send({error:{code:"VALIDATION_ERROR"}});
    try { return {data:await service.read(customer)}; }
    catch { request.log.warn({event:"customer_onboarding_status_unavailable"});return reply.code(503).send({error:{code:"CUSTOMER_ONBOARDING_STATUS_UNAVAILABLE"}}); }
  });
}
