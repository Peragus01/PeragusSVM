import type {Pool} from 'pg';

export interface ApiRateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export interface ApiRateLimiter {
  consume(userId: string, method: string): Promise<ApiRateLimitResult>;
}

// The caller supplies only the ID returned by the verified authenticator.
// All read routes share one budget; all other methods share another budget.
export class PostgresApiRateLimiter implements ApiRateLimiter {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async consume(userId: string, method: string): Promise<ApiRateLimitResult> {
    const bucket = method === 'GET' || method === 'HEAD' ? 'read' : 'write';
    const limit = bucket === 'read' ? 60 : 10;
    const query = {
      text: `insert into peragus_authenticated_api_rate_limits(user_id,bucket,hits)
        values($1,$2,1)
        on conflict(user_id,bucket) do update set
          hits=case when peragus_authenticated_api_rate_limits.window_start<=now()-interval '1 minute'
            then 1 else least(peragus_authenticated_api_rate_limits.hits+1,$3::int+1) end,
          window_start=case when peragus_authenticated_api_rate_limits.window_start<=now()-interval '1 minute'
            then now() else peragus_authenticated_api_rate_limits.window_start end
        returning hits,greatest(1,ceil(extract(epoch from window_start+interval '1 minute'-now())))::int as retry_after`,
      values: [userId,bucket,limit],
      query_timeout: 5000,
    };
    const result = await this.pool.query<{hits:number;retry_after:number}>(query);
    const row = result.rows[0];
    if (!row || !Number.isInteger(row.hits) || !Number.isInteger(row.retry_after))
      throw new Error('RATE_LIMIT_STORE_INVALID');
    return {allowed:row.hits<=limit,limit,remaining:Math.max(0,limit-row.hits),retryAfterSeconds:row.retry_after};
  }
}
