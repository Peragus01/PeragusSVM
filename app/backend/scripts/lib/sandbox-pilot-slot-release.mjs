import { z } from 'zod';

const inputSchema = z.object({
  request_id: z.string().uuid(),
  reason: z.string().trim().min(10).max(300).refine(s => !/[\x00-\x1f\x7f]/.test(s)),
  expected: z.array(z.object({
    slot: z.number().int().min(1).max(5),
    admitted_user_id: z.string().uuid(),
    current_invite_id: z.string().uuid().nullable()
  }).strict()).min(1).max(5)
}).strict();

const normalize = rows => rows.map(r => ({slot:r.slot,admitted_user_id:r.admitted_user_id,current_invite_id:r.current_invite_id})).sort((a,b)=>a.slot-b.slot);
const same = (a,b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

// Caller owns a dedicated database connection and enforces the pinned staging guard.
// Both preview and apply lock the five slots. Preview always rolls back.
export async function releaseSandboxPilotSlots(connection, raw, apply = false) {
  const input = inputSchema.parse(raw);
  if (new Set(input.expected.map(r=>r.slot)).size !== input.expected.length ||
      new Set(input.expected.map(r=>r.admitted_user_id)).size !== input.expected.length)
    throw Error('DUPLICATE_EXPECTED_SLOT');
  await connection.query('BEGIN');
  try {
    await connection.query("SET LOCAL statement_timeout = '10s'");
    await connection.query("SET LOCAL lock_timeout = '5s'");
    const slots = (await connection.query('select slot,admitted_user_id,current_invite_id from peragus_pilot_invite_slots order by slot for update')).rows;
    const previous = (await connection.query('select * from peragus_sandbox_pilot_slot_releases where request_id=$1',[input.request_id])).rows[0];
    if (previous) {
      if (previous.reason !== input.reason || !same(previous.released_slots,input.expected)) throw Error('RELEASE_IDEMPOTENCY_CONFLICT');
      await connection.query('ROLLBACK');
      return {replayed:true,applied:false,released_slots:previous.released_slots};
    }
    if (slots.length !== 5 || !same(slots.filter(s=>s.admitted_user_id !== null),input.expected))
      throw Error('SLOT_SNAPSHOT_CHANGED');
    // Never detach a pending invitation, including one occupying an otherwise free slot.
    const invitations = (await connection.query(`select i.id,i.state,i.environment,i.target_user_id,i.redeemed_by
      from peragus_pilot_invites i join peragus_pilot_invite_slots s on s.current_invite_id=i.id
      order by i.id for update of i`)).rows;
    if (invitations.some(i=>i.environment !== 'test' || i.state === 'issued')) throw Error('ACTIVE_INVITATION_PRESENT');
    for (const slot of input.expected) {
      if (slot.current_invite_id) {
        const invite = invitations.find(i=>i.id===slot.current_invite_id);
        if (!invite || invite.state!=='redeemed' || invite.redeemed_by!==slot.admitted_user_id || invite.target_user_id!==slot.admitted_user_id)
          throw Error('INVITE_SLOT_MISMATCH');
      }
    }
    if (!apply) {
      await connection.query('ROLLBACK');
      return {replayed:false,applied:false,released_slots:normalize(input.expected)};
    }
    await connection.query(`insert into peragus_sandbox_pilot_slot_releases(request_id,reason,released_slots)
      values($1,$2,$3::jsonb)`,[input.request_id,input.reason,JSON.stringify(normalize(input.expected))]);
    for (const slot of input.expected) {
      const updated = await connection.query(`update peragus_pilot_invite_slots set admitted_user_id=null,current_invite_id=null
        where slot=$1 and admitted_user_id=$2 and current_invite_id is not distinct from $3::uuid returning slot`,
      [slot.slot,slot.admitted_user_id,slot.current_invite_id]);
      if (updated.rows.length !== 1) throw Error('SLOT_SNAPSHOT_CHANGED');
    }
    await connection.query('COMMIT');
    return {replayed:false,applied:true,released_slots:normalize(input.expected)};
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  }
}
