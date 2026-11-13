import { describe, expect, it, vi } from 'vitest';
// Standalone operator script; never imported by the API or workers.
import { createGetOnlyHttp, main, probe, PRESENT, ABSENT, UNKNOWN, ACCESS } from '../scripts/ozav-live-capabilities.mjs';

const KEY = 'ozav_sk_live_Zq81KpWm3xTrV7nDcY40hB';
const fullScopes = ['quotes:write', 'transfers:write', 'transfers:read', 'wallets:read', 'verifications:read',
  'verifications:write', 'webhooks:read', 'webhooks:write'];
const full = (over: Record<string, unknown> = {}) => ({
  environment: 'live',
  entitlements: ['customers', 'compliance', 'liquidity', 'custody', 'developer'],
  scopes: fullScopes,
  features: { quotes: 'live', transfers: 'live', wallets: 'live', verifications: 'live', screenings: 'live' },
  ...over,
});
const status = (report: any, id: string) => report.capabilities.find((c: any) => c.id === id).status;

describe('OZAV live capability probe', () => {
  it('refuses non-GET at code level', async () => {
    const fetcher = vi.fn();
    const http = createGetOnlyHttp(fetcher);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      await expect(http('https://x.test/v2/capabilities', { method })).rejects.toThrow('OZAV_PROBE_METHOD_REFUSED');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('makes one GET to /capabilities with redirect error, a timeout signal and no body', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(full()));
    await probe({ key: KEY, fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://developers.ozav.io/v2/capabilities');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init).not.toHaveProperty('body');
  });

  it('prints environment, scopes and entitlements but never the key or any substring of it', async () => {
    const out: string[] = [], err: string[] = [];
    const fetcher = vi.fn().mockResolvedValue(Response.json(full()));
    const code = await main({ OZAV_LIVE_PROBE_API_KEY: KEY }, { fetcher, out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
    const text = out.join('\n');
    expect(code).toBe(2);
    expect(text).toContain('Ambiente: live');
    expect(text).toContain('liquidity');
    expect(text).toContain('quotes:write');
    for (let i = 0; i + 8 <= KEY.length; i++) expect(text).not.toContain(KEY.slice(i, i + 8));
    expect(err).toEqual([]);
  });

  it('never prints the key in error paths', async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => { throw new Error(`network ${KEY}`); },
      async () => new Response(`bad ${KEY}`, { status: 403 }),
      async () => new Response(`not json ${KEY}`),
      async () => Response.json({ echo: KEY, environment: 'live' }),
    ];
    for (const impl of cases) {
      const out: string[] = [], err: string[] = [];
      const code = await main({ OZAV_LIVE_PROBE_API_KEY: KEY }, { fetcher: vi.fn(impl), out: (s: string) => out.push(s), err: (s: string) => err.push(s) });
      const text = out.join('\n') + err.join('\n');
      expect(code).toBe(1);
      for (let i = 0; i + 8 <= KEY.length; i++) expect(text).not.toContain(KEY.slice(i, i + 8));
    }
    const err: string[] = [];
    expect(await main({}, { fetcher: vi.fn(), out: () => {}, err: (s: string) => err.push(s) })).toBe(1);
    expect(err.join('')).toContain('OZAV_PROBE_KEY_REQUIRED');
  });

  it('classifies present, absent and unknown from the response', async () => {
    const fetcher = (body: unknown) => vi.fn().mockResolvedValue(Response.json(body));
    const ok = await probe({ key: KEY, fetcher: fetcher(full()) });
    expect(status(ok, 'onramp_brl_usdt_solana')).toBe(ACCESS);
    expect(status(ok, 'custody_wallet_transfers')).toBe(PRESENT);
    expect(status(ok, 'hosted_kyc_session_url')).toBe(ACCESS);
    expect(status(ok, 'webhooks')).toBe(PRESENT);
    expect(status(ok, 'crypto_address_travel_rule')).toBe(UNKNOWN);
    expect(status(ok, 'fx_rate_lock_facility')).toBe(UNKNOWN);
    expect(ok.ok).toBe(true);

    const absent = await probe({ key: KEY, fetcher: fetcher(full({
      entitlements: ['customers', 'compliance'],
      scopes: fullScopes.filter(s => !s.startsWith('webhooks')),
      features: { quotes: 'live', transfers: 'coming_soon', wallets: 'live', verifications: 'live' },
    })) });
    expect(status(absent, 'onramp_brl_usdt_solana')).toBe(ABSENT);
    expect(status(absent, 'custody_wallet_transfers')).toBe(ABSENT);
    expect(status(absent, 'crypto_address_travel_rule')).toBe(ABSENT);
    expect(status(absent, 'webhooks')).toBe(ABSENT);
    expect(absent.ok).toBe(false);

    const unknown = await probe({ key: KEY, fetcher: fetcher(full({ features: { quotes: 'beta' } })) });
    expect(status(unknown, 'onramp_brl_usdt_solana')).toBe(UNKNOWN);
    expect(status(unknown, 'custody_wallet_transfers')).toBe(UNKNOWN);

    const facility = await probe({ key: KEY, fetcher: fetcher(full({ features: { quotes: 'live', transfers: 'live', fx_rate_lock: 'live' } })) });
    expect(status(facility, 'fx_rate_lock_facility')).toBe(PRESENT);
  });

  it('exits non-zero when the response says environment is not live', async () => {
    for (const environment of ['test', 'sandbox', undefined]) {
      const out: string[] = [];
      const fetcher = vi.fn().mockResolvedValue(Response.json(full({ environment })));
      expect(await main({ OZAV_LIVE_PROBE_API_KEY: KEY }, { fetcher, out: (s: string) => out.push(s), err: () => {} })).toBe(1);
      expect(out.join('\n')).toContain('FALHA');
    }
  });

  it('exits non-zero when a required capability is clearly absent and 2 with only pending items', async () => {
    const out: string[] = [];
    const absent = vi.fn().mockResolvedValue(Response.json(full({ scopes: ['quotes:write'] })));
    expect(await main({ OZAV_LIVE_PROBE_API_KEY: KEY }, { fetcher: absent, out: (s: string) => out.push(s), err: () => {} })).toBe(1);
    const out2: string[] = [];
    const unknownOnly = vi.fn().mockResolvedValue(Response.json(full()));
    expect(await main({ OZAV_LIVE_PROBE_API_KEY: KEY }, { fetcher: unknownOnly, out: (s: string) => out2.push(s), err: () => {} })).toBe(2);
    const text2 = out2.join('\n');
    expect(text2).toContain('Não informado');
    expect(text2).toContain('acesso concedido — rota não comprovada');
    expect(text2).toContain('a rota BRL->USDT/Solana em si não aparece');
    expect(text2).toContain('o session_url só existe por verificação');
    expect(text2).toContain('acesso concedido pelo /capabilities; não prova a rota');
  });

  it('requires the developer entitlement for webhooks', async () => {
    const r = await probe({ key: KEY, fetcher: vi.fn().mockResolvedValue(Response.json(full({ entitlements: ['customers', 'compliance', 'liquidity', 'custody'] }))) });
    expect(status(r, 'webhooks')).toBe(ABSENT);
    expect(r.ok).toBe(false);
  });

  it('refuses non-https or non-OZAV base URLs unless explicitly allowed, before sending the key', async () => {
    for (const baseUrl of ['http://developers.ozav.io/v2', 'https://evil.test/v2', 'https://developers.ozav.io.evil.test/v2', 'not a url']) {
      const fetcher = vi.fn();
      await expect(probe({ key: KEY, baseUrl, fetcher })).rejects.toThrow('OZAV_PROBE_BASE_URL_REFUSED');
      expect(fetcher).not.toHaveBeenCalled();
    }
    const fetcher = vi.fn().mockResolvedValue(Response.json(full()));
    await probe({ key: KEY, baseUrl: 'http://127.0.0.1:9/v2', fetcher, allowCustomBase: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const err: string[] = [];
    const f2 = vi.fn();
    expect(await main({ OZAV_LIVE_PROBE_API_KEY: KEY, OZAV_BASE_URL: 'https://evil.test/v2' }, { fetcher: f2, out: () => {}, err: (s: string) => err.push(s) })).toBe(1);
    expect(f2).not.toHaveBeenCalled();
    expect(err.join('')).toContain('OZAV_PROBE_BASE_URL_REFUSED');
  });
});
