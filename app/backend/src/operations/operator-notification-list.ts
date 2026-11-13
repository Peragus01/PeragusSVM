import type {Pool} from "pg";
import {z} from "zod";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment,type RowEnvironment} from "../repositories/row-environment.js";
import type {AuthenticatedUser} from "../auth/customer-access.js";
import {authorizeWithdrawalOperator} from "../withdrawals/operator-approvals.js";

/** Most rows returned by GET /v1/admin/operator-notifications. */
export const OPERATOR_NOTIFICATION_LIST_LIMIT=100;
export class OperatorNotificationListInputError extends Error {}
const querySchema=z.object({status:z.enum(["uncertain","failed"]).optional()}).strict();

interface Row {
 id:string;kind:string;severity:string;recipient:"operator"|"trusted";status:"uncertain"|"failed";last_error:string|null;
 purchase_id:string|null;created_at:string;first_attempt_at:string|null;updated_at:string;
}
const iso=(column:string)=>`to_char(${column} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Read-only list of operator e-mail notifications that did not reach a confirmed send
 * ('uncertain' or 'failed'), newest first. Allowlisted operator with AAL2 (like the alerts
 * list). Returns ids, kinds, statuses and timestamps only: never the payload, the dedupe or
 * idempotency keys, or any recipient address (addresses are not stored; the role is).
 */
export class OperatorNotificationListService {
 private readonly e:RowEnvironment;
 constructor(private readonly pool:Pick<Pool,"query">,private readonly operators:ReadonlySet<string>,mode:MoneyMode){this.e=rowEnvironment(mode);}
 authorize(user:AuthenticatedUser){authorizeWithdrawalOperator(user,this.operators);}
 async list(user:AuthenticatedUser,query:unknown){
  this.authorize(user);
  const parsed=querySchema.safeParse(query);
  if(!parsed.success)throw new OperatorNotificationListInputError();
  const statuses=parsed.data.status?[parsed.data.status]:["uncertain","failed"];
  const result=await this.pool.query<Row>(`select id,kind,severity,recipient,status,last_error,purchase_id,
   ${iso("created_at")} as created_at,case when first_attempt_at is null then null else ${iso("first_attempt_at")} end as first_attempt_at,
   ${iso("updated_at")} as updated_at
   from peragus_operator_notifications where environment='${this.e.mode}' and status=any($1::text[])
   order by updated_at desc,id desc limit ${OPERATOR_NOTIFICATION_LIST_LIMIT}`,[statuses]);
  return{data:result.rows.map(row=>({id:row.id,kind:row.kind,severity:row.severity,recipient_role:row.recipient,status:row.status,
   last_error:row.last_error,purchase_id:row.purchase_id,created_at:row.created_at,first_attempt_at:row.first_attempt_at,
   updated_at:row.updated_at,environment:this.e.mode})),
   meta:{environment:this.e.mode,limit:OPERATOR_NOTIFICATION_LIST_LIMIT,status:parsed.data.status??"all"}};
 }
}
