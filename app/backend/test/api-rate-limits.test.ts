import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {beforeAll,beforeEach,afterEach,afterAll,it,expect,vi} from 'vitest';
import {PostgresApiRateLimiter} from '../src/auth/api-rate-limits.js';
import {AuthenticationError,type CustomerRepository} from '../src/auth/customer-access.js';
import {buildApp} from '../src/app.js';

const db=new PGlite();
const pool={query:async(config:any,args?:unknown[])=>{
 const result=await db.query(typeof config==='string'?config:config.text,typeof config==='string'?args:config.values);
 return {...result,rowCount:result.rows.length};
}} as unknown as Pool;
const alice=randomUUID(),bob=randomUUID();
const apps:Awaited<ReturnType<typeof buildApp>>[]=[];
beforeAll(async()=>{
 await db.exec('create role anon;create role authenticated;');
 const dir=new URL('../migrations/',import.meta.url);
 for(const f of (await readdir(dir)).filter(f=>/^\d+_.*\.sql$/.test(f)).sort())await db.exec(await readFile(new URL(f,dir),'utf8'));
},30000);
beforeEach(()=>db.exec('truncate peragus_authenticated_api_rate_limits'));
afterEach(async()=>{await Promise.all(apps.splice(0).map(a=>a.close()));});
afterAll(()=>db.close());
const limiter=()=>new PostgresApiRateLimiter(pool);
const headers=(token='alice')=>({authorization:`Bearer ${token}`});
async function seed(id:string,bucket='read',hits=60){
 await db.query('insert into peragus_authenticated_api_rate_limits(user_id,bucket,hits) values($1,$2,$3)',[id,bucket,hits]);
}
async function setup(rate=limiter()){
 const customers={findByOwner:vi.fn(async()=>null),createOrGet:vi.fn(),ownsSettlement:vi.fn()} as unknown as CustomerRepository;
 const authenticate=vi.fn(async(token:string)=>{
  if(token==='bad')throw new AuthenticationError('INVALID_TOKEN');
  return {id:token==='bob'?bob:alice,email:'synthetic@example.test'};
 });
 const app=await buildApp({customerAccess:{customers,authenticate},apiRateLimiter:rate});
 const handler=customers.createOrGet;
 apps.push(app);return {app,customers,authenticate,handler};
}

it('allows exactly sixty reads across independent instances and concurrent calls',async()=>{
 const one=limiter(),two=limiter();
 const results=await Promise.all(Array.from({length:70},(_,i)=>(i%2?one:two).consume(alice,i%3?'GET':'HEAD')));
 expect(results.filter(r=>r.allowed)).toHaveLength(60);
 expect(results.filter(r=>!r.allowed)).toHaveLength(10);
 expect(results.at(-1)).toMatchObject({limit:60,remaining:0});
 expect((await db.query<any>('select hits from peragus_authenticated_api_rate_limits')).rows).toEqual([{hits:61}]);
});
it('separates verified users and read/write quotas while sharing write methods',async()=>{
 const l=limiter();
 for(let i=0;i<10;i++)expect((await l.consume(alice,i%2?'POST':'DELETE')).allowed).toBe(true);
 expect((await l.consume(alice,'PUT')).allowed).toBe(false);
 expect(await l.consume(alice,'GET')).toMatchObject({allowed:true,remaining:59});
 expect(await l.consume(bob,'PATCH')).toMatchObject({allowed:true,remaining:9});
});
it('resets an expired window with database time and returns a bounded retry interval',async()=>{
 await seed(alice);
 const blocked=await limiter().consume(alice,'GET');
 expect(blocked.allowed).toBe(false);
 expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
 expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60);
 await db.query("update peragus_authenticated_api_rate_limits set window_start=now()-interval '61 seconds'");
 expect(await limiter().consume(alice,'GET')).toMatchObject({allowed:true,remaining:59});
});
it('blocks before customer lookup with safe cache and retry headers',async()=>{
 await seed(alice);const {app,customers}=await setup();
 const response=await app.inject({url:'/v1/me',headers:headers()});
 expect(response.statusCode).toBe(429);
 expect(response.json()).toEqual({error:{code:'API_RATE_LIMIT_EXCEEDED'}});
 expect(response.headers['cache-control']).toBe('no-store');
 expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
 expect(response.headers['ratelimit-remaining']).toBe('0');
 expect(response.headers['ratelimit-limit']).toBe('60');
 expect(customers.findByOwner).not.toHaveBeenCalled();
});
it('does not bypass a user quota with another token, header, query or route',async()=>{
 await seed(alice);const {app}=await setup();
 for(const token of ['alice','another-synthetic-token']){
  const response=await app.inject({url:'/v1/me/customer?user_id='+bob,headers:{...headers(token),'x-forwarded-for':'203.0.113.2','x-user-id':bob}});
  expect(response.statusCode).toBe(429);
 }
 expect((await app.inject({url:'/v1/me',headers:headers('bob')})).statusCode).toBe(200);
});
it('authenticates before charging a quota and leaves health public',async()=>{
 const {app}=await setup();
 expect((await app.inject({url:'/v1/me'})).statusCode).toBe(401);
 expect((await app.inject({url:'/v1/me',headers:headers('bad')})).statusCode).toBe(401);
 expect((await app.inject({url:'/health'})).statusCode).toBe(200);
 expect((await db.query('select * from peragus_authenticated_api_rate_limits')).rows).toHaveLength(0);
});
it('blocks writes before handler execution, without changing financial state',async()=>{
 await seed(alice,'write',10);const {app,handler}=await setup();
 const response=await app.inject({method:'POST',url:'/v1/me/customer',headers:headers(),payload:{type:'pf',display_name:'Synthetic customer'}});
 expect(response.statusCode).toBe(429);expect(handler).not.toHaveBeenCalled();
 expect((await db.query('select * from peragus_customers')).rows).toHaveLength(0);
});
it('fails closed and never echoes database errors',async()=>{
 const broken=new PostgresApiRateLimiter({query:async()=>{throw Error('postgres secret credentials');}} as any);
 const {app,customers,handler}=await setup(broken);
 for(const [method,url] of [['GET','/v1/me'],['POST','/v1/me/customer']] as const){
  const response=await app.inject({method,url,headers:headers(),...(method==='POST'?{payload:{}}:{})});
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({error:{code:'API_RATE_LIMIT_UNAVAILABLE'}});
  expect(response.body).not.toMatch(/secret|postgres|credentials/);
  expect(response.headers['retry-after']).toBe('1');
 }
 expect(customers.findByOwner).not.toHaveBeenCalled();expect(handler).not.toHaveBeenCalled();
});
it('does not replace customer ownership and role separation with a quota',async()=>{
 const {app,customers}=await setup();
 expect((await app.inject({url:'/v1/me/operations',headers:headers()})).statusCode).toBe(403);
 (customers.findByOwner as any).mockResolvedValue({id:randomUUID()});
 expect((await app.inject({url:'/v1/admin/pilot-invites/'+randomUUID(),headers:headers()})).json()).toEqual({error:{code:'OPERATOR_ACCOUNT_SEPARATION_REQUIRED'}});
});
it('keeps existing behavior when the limiter is not configured',async()=>{
 const customers={findByOwner:async()=>null} as unknown as CustomerRepository;
 const app=await buildApp({customerAccess:{customers,authenticate:async()=>({id:alice,email:'synthetic@example.test'})}});
 apps.push(app);
 await seed(alice);
 const response=await app.inject({url:'/v1/me',headers:headers()});
 expect(response.statusCode).toBe(200);expect(response.headers['ratelimit-limit']).toBeUndefined();
});
it('refuses a limiter without authentication and protects storage from browser roles',async()=>{
 await expect(buildApp({apiRateLimiter:limiter()})).rejects.toThrow('verified authentication');
 for(const role of ['anon','authenticated'])
  expect((await db.query<any>("select has_table_privilege($1,'peragus_authenticated_api_rate_limits','select') as allowed",[role])).rows[0].allowed).toBe(false);
 expect((await db.query<any>("select relrowsecurity from pg_class where relname='peragus_authenticated_api_rate_limits'")).rows[0].relrowsecurity).toBe(true);
});
