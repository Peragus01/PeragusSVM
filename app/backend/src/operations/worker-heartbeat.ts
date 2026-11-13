import type {Pool} from "pg";
import type {MoneyMode} from "../config/money-environment.js";
import {rowEnvironment} from "../repositories/row-environment.js";

/** The background worker beats this often; /ready fails when the last beat is older than the max age. */
export const WORKER_HEARTBEAT_INTERVAL_MS=60_000;
export const WORKER_HEARTBEAT_MAX_AGE_SECONDS=180;
const WORKER="worker";

/** Upserts the worker's heartbeat (database clock). */
export async function recordWorkerHeartbeat(pool:Pick<Pool,"query">,mode:MoneyMode){
 const e=rowEnvironment(mode);
 await pool.query(`insert into peragus_worker_heartbeats(worker,environment,beat_at) values($1,'${e.mode}',now())
  on conflict(worker,environment) do update set beat_at=now()`,[WORKER]);
}

/** Starts beating every minute; returns a stop function. A failed beat is logged by code only. */
export function startWorkerHeartbeat(pool:Pick<Pool,"query">,mode:MoneyMode,log:(event:Record<string,unknown>)=>void=()=>undefined){
 const beat=()=>recordWorkerHeartbeat(pool,mode).catch(()=>log({event:"worker_heartbeat_failed",code:"WORKER_HEARTBEAT_UNAVAILABLE"}));
 void beat();
 const timer=setInterval(()=>void beat(),WORKER_HEARTBEAT_INTERVAL_MS);
 timer.unref?.();
 return()=>clearInterval(timer);
}

/** Readiness probe: throws unless the worker beat within the max age (database clock). */
export function workerHeartbeatProbe(pool:Pick<Pool,"query">,mode:MoneyMode,maxAgeSeconds=WORKER_HEARTBEAT_MAX_AGE_SECONDS){
 const e=rowEnvironment(mode);
 return async()=>{
  const r=await pool.query<{fresh:boolean}>(`select beat_at>now()-make_interval(secs=>$2) as fresh from peragus_worker_heartbeats
   where worker=$1 and environment='${e.mode}'`,[WORKER,maxAgeSeconds]);
  if(r.rows[0]?.fresh!==true)throw new Error("WORKER_HEARTBEAT_STALE");
 };
}
