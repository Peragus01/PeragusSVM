import 'dotenv/config';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {assertSmokeTestSafety} from '../dist/jobs/worker-smoke-test.js';
import {releaseSandboxPilotSlots} from './lib/sandbox-pilot-slot-release.mjs';

let pool;
try {
  const [planFile,mode] = process.argv.slice(2);
  if (!planFile || !['--preview','--apply'].includes(mode) || process.argv.length!==4)
    throw Error('USE_PLAN_FILE_AND_PREVIEW_OR_APPLY');
  const flags={};
  for (const name of ['OZAV_ONRAMP_WRITES_ENABLED','OZAV_OFFRAMP_WRITES_ENABLED','SOLANA_COSIGNING_ENABLED','SOLANA_CONTINGENCY_RESERVE_ENABLED','PERAGUS_SANDBOX_DEMO_ENABLED']) {
    if (process.env[name]!=='false') throw Error('FINANCIAL_FLAGS_MUST_BE_FALSE');
    flags[name]=false;
  }
  assertSmokeTestSafety({DATABASE_URL:process.env.DATABASE_URL,...flags});
  if (process.env.DATABASE_SSL!=='true' || process.env.SUPABASE_URL?.replace(/\/$/,'')!=='https://lybdkqkbwlfwvmmvstzi.supabase.co')
    throw Error('STAGING_CONFIGURATION_REQUIRED');
  for (const name of ['PILOT_INVITES_ENABLED','SANDBOX_WITHDRAWAL_EXECUTION_ENABLED','WITHDRAWAL_OPERATOR_APPROVALS_ENABLED','SANDBOX_WITHDRAWAL_RECOVERY_ENABLED','MANUAL_REFUNDS_ENABLED','CUSTOMER_RECONCILIATION_ENABLED'])
    if (process.env[name]!=='false') throw Error(`DISABLE_${name}`);
  if (mode==='--apply' && process.env.SANDBOX_SLOT_RELEASE_CONFIRMATION!=='RELEASE_TEST_ADMISSIONS_ONLY')
    throw Error('EXPLICIT_SANDBOX_RELEASE_CONFIRMATION_REQUIRED');
  const plan=JSON.parse(await readFile(planFile,'utf8'));
  pool=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:1,connectionTimeoutMillis:10000});
  const connection=await pool.connect();
  try {
    const result=await releaseSandboxPilotSlots(connection,plan,mode==='--apply');
    console.log(JSON.stringify({etapa:'sandbox_pilot_slot_release',...result,customers_preserved:true,invite_history_preserved:true,no_provider_calls:true},null,2));
  } finally {connection.release();}
} catch (error) {
  console.error({etapa:'sandbox_pilot_slot_release',interrompido:true,codigo:error.code??(/^[A-Z_]+$/.test(error.message)?error.message:'RELEASE_FAILED')});
  process.exitCode=1;
} finally {if(pool)await pool.end();}
