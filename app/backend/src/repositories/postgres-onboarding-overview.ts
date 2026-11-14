import type { Pool } from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "./row-environment.js";
import type { OnboardingOverviewRepository, OverviewFacts } from "../onboarding/customer-onboarding-overview.js";
// A single statement observes one PostgreSQL snapshot. Never select ciphertext,
// acceptance evidence, provider payloads, auth IDs or personally identifying form fields.
export class PostgresOnboardingOverviewRepository implements OnboardingOverviewRepository {
  private readonly e: RowEnvironment;
  constructor(private readonly pool: Pool, mode: MoneyMode) { this.e = rowEnvironment(mode); }
  async read(customerId: string): Promise<OverviewFacts> {
    const r = await this.pool.query<OverviewFacts>(`
      select
        case when w.customer_id is null then null else jsonb_build_object(
          'wallet_address',w.wallet_address,'verified_at',w.verified_at) end as wallet,
        (v.customer_id is null or (s.state='linked' and v.provider_customer_id=s.provider_customer_id))
        and (sc.customer_id is null or (s.state='linked' and sc.provider_customer_id=s.provider_customer_id)) as binding_consistent,
        case when d.customer_id is null then null else jsonb_build_object(
          'version',d.version,'updated_at',d.updated_at) end as draft,
        case when t.id is null then null else jsonb_build_object(
          'session_id',t.id,'state',t.state,'version',t.terms_version,'expires_at',t.expires_at,
          'accepted_at',t.accepted_at,'active',t.active) end as terms,
        case when s.customer_id is null then null else jsonb_build_object(
          'state',s.state,'draft_version',s.draft_version,'provider_status',s.provider_status,
          'verification_mode',s.verification_mode,'requirements_pending',s.provider_snapshot->'requirements_pending',
          'due_count',s.provider_snapshot->'due_count','missing_fields_count',s.provider_snapshot->'missing_fields_count',
          'documents_due_count',s.provider_snapshot->'documents_due_count','refreshed_at',s.refreshed_at) end as registration,
        case when v.customer_id is null then null else jsonb_build_object(
          'status',v.observation->'status','checks',coalesce(v.observation->'checks','{}'::jsonb),
          'refreshed_at',v.refreshed_at) end as identity,
        case when sc.customer_id is null then null else jsonb_build_object(
          'status',sc.observation->'status','result',sc.observation->'result','lists',sc.observation->'lists',
          'matches_count',sc.observation->'matchesCount','suggested_decision',sc.observation->'suggestedDecision',
          'refreshed_at',sc.refreshed_at) end as screening
      from peragus_customers c
      left join peragus_individual_onboarding_drafts d on d.customer_id=c.id and d.environment='${this.e.mode}'
      left join peragus_customer_onboarding_submissions s on s.customer_id=c.id and s.environment='${this.e.mode}'
      left join peragus_customer_terms_sessions t on t.customer_id=c.id and t.environment='${this.e.mode}'
        and ((s.customer_id is not null and t.id=s.terms_session_id) or (s.customer_id is null and t.active))
      left join peragus_customer_verifications v on v.customer_id=c.id and v.environment='${this.e.mode}'
      left join peragus_customer_screenings sc on sc.customer_id=c.id and sc.environment='${this.e.mode}'
      left join peragus_customer_wallets w on w.customer_id=c.id and w.environment='${this.e.mode}' and w.network='${this.e.network}'
      where c.id=$1`, [customerId]);
    if (r.rows.length !== 1) throw new Error("ONBOARDING_OVERVIEW_UNAVAILABLE");
    return r.rows[0]!;
  }
}
