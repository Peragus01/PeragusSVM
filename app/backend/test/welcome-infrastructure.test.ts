import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const history = (name: string) => readFile(new URL(`../../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const expansion = await readFile(new URL('../migrations/037_expand_operator_invites.sql', import.meta.url), 'utf8');
const reconciliation = await readFile(new URL('../scripts/sql/reconcile-operator-invites-ledger.sql', import.meta.url), 'utf8');

async function inviteDatabase(source = expansion) {
  const db = new PGlite();
  await db.exec(`
    create schema supabase_migrations;
    create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);
    create table public.peragus_schema_migrations(filename text primary key,checksum text not null,applied_at timestamptz default now());
    create table public.peragus_pilot_invite_slots(slot smallint primary key check(slot between 1 and 5));
    create table public.peragus_pilot_invites(id int primary key,slot smallint references public.peragus_pilot_invite_slots(slot));
    insert into public.peragus_pilot_invite_slots values(1);
    insert into public.peragus_pilot_invites values(1,1);
  `);
  await db.exec(expansion);
  await db.query('insert into supabase_migrations.schema_migrations values($1,$2,$3::text[])',
    ['20261101181204','expand_operator_invites_037',[source]]);
  return db;
}

describe('staging infrastructure provenance', () => {
  it('preserves the applied operator SQL byte-for-byte', async () => {
    expect(await history('20261101181204_expand_operator_invites_037.sql')).toBe(expansion);
  });
  it('adopts an exact applied migration once without replaying schema or sequence changes', async () => {
    const db = await inviteDatabase();
    try {
      await db.exec("select setval('public.peragus_pilot_invite_slot_sequence',100,true)");
      await db.exec(reconciliation);
      await db.exec(reconciliation);
      expect((await db.query('select count(*)::int n from peragus_schema_migrations')).rows).toEqual([{n:1}]);
      expect((await db.query('select count(*)::int n from peragus_pilot_invites')).rows).toEqual([{n:1}]);
      expect((await db.query('select last_value::int n from peragus_pilot_invite_slot_sequence')).rows).toEqual([{n:100}]);
    } finally { await db.close(); }
  });
  it('refuses changed source history and leaves the ledger empty', async () => {
    const db = await inviteDatabase(expansion+'-- different history');
    try {
      await expect(db.exec(reconciliation)).rejects.toThrow('RECONCILIATION_SOURCE_MISMATCH');
      await db.exec('rollback');
      expect((await db.query('select count(*)::int n from peragus_schema_migrations')).rows).toEqual([{n:0}]);
    } finally { await db.close(); }
  });
  it('refuses schema drift even with matching historical SQL', async () => {
    const db = await inviteDatabase();
    try {
      await db.exec('drop sequence public.peragus_pilot_invite_slot_sequence');
      await expect(db.exec(reconciliation)).rejects.toThrow('RECONCILIATION_SCHEMA_MISMATCH');
      await db.exec('rollback');
    } finally { await db.close(); }
  });
  it('does not overwrite conflicting backend checksums', async () => {
    const db = await inviteDatabase();
    try {
      await db.query('insert into peragus_schema_migrations(filename,checksum) values($1,$2)', ['037_expand_operator_invites.sql','0'.repeat(64)]);
      await expect(db.exec(reconciliation)).rejects.toThrow('RECONCILIATION_LEDGER_CONFLICT');
      await db.exec('rollback');
      expect((await db.query('select checksum from peragus_schema_migrations')).rows).toEqual([{checksum:'0'.repeat(64)}]);
    } finally { await db.close(); }
  });
  it('queues confirmation once, keeps sent rows, and denies public RPC callers', async () => {
    const db = new PGlite();
    try {
      await db.exec(`create role anon; create role authenticated; create role service_role;
        create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');`);
      for (const file of ['20261101024529_welcome_email_outbox_on_confirmation.sql','20261101024555_welcome_handle_autoconfirmed_signups.sql','20261101024609_welcome_private_worker_rpc.sql']) await db.exec(await history(file));
      await db.exec(`insert into auth.users(id,email) values('11111111-1111-4111-8111-111111111111','synthetic@example.test');`);
      expect((await db.query('select count(*)::int n from internal.welcome_email_outbox')).rows).toEqual([{n:0}]);
      await db.exec('update auth.users set email_confirmed_at=now()');
      const claimed = await db.query('select * from public.claim_welcome_email()');
      expect(claimed.rows).toHaveLength(1);
      await db.exec("select public.finish_welcome_email('11111111-1111-4111-8111-111111111111',true,'synthetic-provider-id',null)");
      await db.exec('update auth.users set email_confirmed_at=now()');
      expect((await db.query('select state,attempts from internal.welcome_email_outbox')).rows).toEqual([{state:'sent',attempts:1}]);
      expect((await db.query('select * from public.claim_welcome_email()')).rows).toHaveLength(0);
      for (const role of ['anon','authenticated']) {
        await db.exec(`set role ${role}`);
        await expect(db.query('select * from public.claim_welcome_email()')).rejects.toThrow(/permission denied/);
        await db.exec('reset role');
      }
    } finally { await db.close(); }
  });
});
