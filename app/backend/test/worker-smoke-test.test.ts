import { describe, expect, it, vi } from 'vitest';
import { assertSmokeTestSafety, registerWorkerSmokeTest, smokePayload } from '../src/jobs/worker-smoke-test.js';
const safe = {
 DATABASE_URL: 'postgresql://postgres.lybdkqkbwlfwvmmvstzi:unused@aws-0-sa-east-1.pooler.supabase.com:5432/postgres',
 OZAV_ONRAMP_WRITES_ENABLED: false, OZAV_OFFRAMP_WRITES_ENABLED: false,
 SOLANA_COSIGNING_ENABLED: false, SOLANA_CONTINGENCY_RESERVE_ENABLED: false,
 PERAGUS_SANDBOX_DEMO_ENABLED: false,
};
describe('isolated staging worker diagnostic', () => {
 it('accepts only the pinned staging database', () => {
  expect(() => assertSmokeTestSafety(safe)).not.toThrow();
  for (const DATABASE_URL of [undefined, 'postgresql://postgres.other:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres', safe.DATABASE_URL.replace('5432', '6543'), safe.DATABASE_URL.replace('supabase.com', 'supabase.com.evil.test')]) {
   expect(() => assertSmokeTestSafety({ ...safe, DATABASE_URL })).toThrow();
  }
 });
 it.each(['OZAV_ONRAMP_WRITES_ENABLED','OZAV_OFFRAMP_WRITES_ENABLED','SOLANA_COSIGNING_ENABLED','SOLANA_CONTINGENCY_RESERVE_ENABLED','PERAGUS_SANDBOX_DEMO_ENABLED'])('rejects enabled %s', (flag) => {
  expect(() => assertSmokeTestSafety({ ...safe, [flag]: true })).toThrow();
 });
 it('rejects financial payload fields', () => {
  expect(() => smokePayload.parse({ diagnosticId: '123e4567-e89b-42d3-a456-426614174000', settlementId: 'unexpected' })).toThrow();
 });
 it('registers only the diagnostic queue and returns correlated output', async () => {
  const createQueue = vi.fn(); const work = vi.fn();
  await registerWorkerSmokeTest({ createQueue, work } as never);
  expect(createQueue.mock.calls[0]?.[0]).toBe('peragus-worker-smoke-test');
  const handler = work.mock.calls[0]![2];
  const diagnosticId = '123e4567-e89b-42d3-a456-426614174000';
  expect(await handler([{ id: diagnosticId, data: { diagnosticId } }])).toMatchObject({ diagnosticId, project: 'lybdkqkbwlfwvmmvstzi' });
  await expect(handler([{ id: 'bad', data: { settlementId: diagnosticId } }])).rejects.toThrow();
 });
});
