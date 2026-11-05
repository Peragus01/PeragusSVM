import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
// @ts-ignore Administrative ESM tool is exercised directly by Vitest.
import {releaseSandboxPilotSlots as release} from '../scripts/lib/sandbox-pilot-slot-release.mjs';

const db=new PGlite();
const connection={query:(sql:string,args?:unknown[])=>db.query(sql,args)};
let owner:string;
const plan=()=>({request_id:randomUUID(),reason:'Release synthetic sandbox test admission.',expected:[{slot:1,admitted_user_id:owner,current_invite_id:null}]});
beforeAll(async()=>{
 await db.exec('create role anon;create role authenticated;');
 const dir=new URL('../migrations/',import.meta.url);
 for(const name of (await readdir(dir)).filter(n=>/^\d+_.*\.sql$/.test(n)).sort())
  await db.exec(await readFile(new URL(name,dir),'utf8'));
},30000);
beforeEach(async()=>{
 await db.exec('truncate peragus_customers,peragus_pilot_invites,peragus_pilot_invite_slots,peragus_sandbox_pilot_slot_releases cascade;insert into peragus_pilot_invite_slots(slot) select generate_series(1,5)');
 owner=randomUUID();
 await db.query("insert into peragus_customers(id,owner_user_id,customer_type,display_name) values($1,$2,'pf','Synthetic slot customer')",[randomUUID(),owner]);
 await db.query('update peragus_pilot_invite_slots set admitted_user_id=$1 where slot=1',[owner]);
});
afterAll(()=>db.close());
const rows=async(sql:string)=>(await db.query(sql)).rows;

it('previews without changing slots or audit',async()=>{
 expect(await release(connection,plan(),false)).toMatchObject({applied:false,replayed:false});
 expect(await rows('select admitted_user_id from peragus_pilot_invite_slots where slot=1')).toEqual([{admitted_user_id:owner}]);
 expect(await rows('select * from peragus_sandbox_pilot_slot_releases')).toHaveLength(0);
});
it('releases atomically and preserves customer and immutable redeemed evidence',async()=>{
 const id=randomUUID();
 await db.query(`insert into peragus_pilot_invites(id,slot,target_user_id,operator_user_id,request_id,reason,duration_hours,code_hash,expires_at,state,redeemed_by,redemption_request_id,redeemed_at)
 values($1,1,$2,$3,$4,'Synthetic admission reason',1,$5,now()+interval '1 hour','redeemed',$2,$6,now())`,[id,owner,randomUUID(),randomUUID(),'a'.repeat(64),randomUUID()]);
 await db.query('update peragus_pilot_invite_slots set current_invite_id=$1 where slot=1',[id]);
 const input=plan();input.expected[0]!.current_invite_id=id as any;
 expect(await release(connection,input,true)).toMatchObject({applied:true});
 expect(await rows('select * from peragus_customers')).toHaveLength(1);
 expect(await rows('select state from peragus_pilot_invites')).toEqual([{state:'redeemed'}]);
 expect(await rows('select admitted_user_id,current_invite_id from peragus_pilot_invite_slots where slot=1')).toEqual([{admitted_user_id:null,current_invite_id:null}]);
 const audit:any[] = await rows('select * from peragus_sandbox_pilot_slot_releases');
 expect(audit[0].released_slots).toEqual(input.expected);
 expect(audit[0].database_actor).toBeTruthy();
 await expect(db.query('delete from peragus_sandbox_pilot_slot_releases')).rejects.toThrow('append only');
 await expect(db.query("update peragus_pilot_invites set state='issued'")).rejects.toThrow();
});
it('replay does not clear a subsequently occupied slot',async()=>{
 const input=plan();await release(connection,input,true);
 await db.query('update peragus_pilot_invite_slots set admitted_user_id=$1 where slot=1',[owner]);
 expect(await release(connection,input,true)).toMatchObject({replayed:true,applied:false});
 expect(await rows('select admitted_user_id from peragus_pilot_invite_slots where slot=1')).toEqual([{admitted_user_id:owner}]);
 await expect(release(connection,{...input,reason:'Changed request reason.'},true)).rejects.toThrow('RELEASE_IDEMPOTENCY_CONFLICT');
});
it('rejects an unexpected occupant without partial changes',async()=>{
 const input=plan();input.expected[0]!.admitted_user_id=randomUUID();
 await expect(release(connection,input,true)).rejects.toThrow('SLOT_SNAPSHOT_CHANGED');
 expect(await rows('select * from peragus_sandbox_pilot_slot_releases')).toHaveLength(0);
});
it('refuses active invitations even in otherwise unoccupied slots',async()=>{
 const id=randomUUID();
 await db.query(`insert into peragus_pilot_invites(id,slot,target_user_id,operator_user_id,request_id,reason,duration_hours,code_hash,expires_at)
 values($1,2,$2,$3,$4,'Synthetic active reason',1,$5,now()+interval '1 hour')`,[id,randomUUID(),randomUUID(),randomUUID(),'b'.repeat(64)]);
 await db.query('update peragus_pilot_invite_slots set current_invite_id=$1 where slot=2',[id]);
 await expect(release(connection,plan(),true)).rejects.toThrow('ACTIVE_INVITATION_PRESENT');
});
it('rolls back audit if the slot update fails',async()=>{
 await db.exec(`create function reject_slot_release() returns trigger language plpgsql as $$ begin raise exception 'synthetic failure'; end $$;
 create trigger reject_slot_release before update on peragus_pilot_invite_slots for each row execute function reject_slot_release()`);
 try {
  await expect(release(connection,plan(),true)).rejects.toThrow('synthetic failure');
  expect(await rows('select * from peragus_sandbox_pilot_slot_releases')).toHaveLength(0);
  expect(await rows('select admitted_user_id from peragus_pilot_invite_slots where slot=1')).toEqual([{admitted_user_id:owner}]);
 } finally {await db.exec('drop trigger reject_slot_release on peragus_pilot_invite_slots;drop function reject_slot_release()');}
});
it('rejects duplicate snapshots and revokes browser access to audit',async()=>{
 const input=plan();input.expected.push(input.expected[0]!);
 await expect(release(connection,input,true)).rejects.toThrow('DUPLICATE_EXPECTED_SLOT');
 for(const role of ['anon','authenticated'])
  expect((await db.query<any>("select has_table_privilege($1,'peragus_sandbox_pilot_slot_releases','select') as allowed",[role])).rows[0].allowed).toBe(false);
});
