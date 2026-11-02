import { describe, expect, it, vi } from 'vitest';
// Standalone diagnostic; never imported by API or financial workers.
import { inspectCapabilities, summarizeCapabilities } from '../scripts/lib/ozav-readiness.mjs';

const capability = (environment = 'live') => ({environment,
  entitlements: ['customers','compliance','liquidity','custody'],
  scopes: ['customers:read','verifications:read'],
  features: {verifications:'beta',wallets:'live',transfers:'coming_soon'},
});
describe('read-only live capability inspection', () => {
  it('makes exactly one GET to the fixed provider origin and never follows redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(capability()));
    const report = await inspectCapabilities({key:'ozav_sk_live_synthetic',fetcher});
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://developers.ozav.io/v2/capabilities');
    expect(fetcher.mock.calls[0][1]).toMatchObject({method:'GET',redirect:'error'});
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body');
    expect(report.features.transfers).toBe('coming_soon');
    expect(report.financial_operations_authorized).toBe(false);
    expect(report.hosted_capture_verified).toBe(false);
    expect(report.missing_baseline_scopes).toContain('transfers:write');
  });
  it('refuses missing keys, invalid modes and wrong-environment keys before requesting', async () => {
    const fetcher = vi.fn();
    await expect(inspectCapabilities({key:undefined,fetcher})).rejects.toThrow('OZAV_READINESS_KEY_REQUIRED');
    await expect(inspectCapabilities({key:'ozav_sk_test_synthetic',fetcher})).rejects.toThrow('OZAV_KEY_ENVIRONMENT_MISMATCH');
    await expect(inspectCapabilities({key:'ozav_sk_live_synthetic',expectedEnvironment:'production',fetcher})).rejects.toThrow('OZAV_EXPECTED_ENVIRONMENT_INVALID');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('reports a provider environment mismatch without granting readiness', async () => {
    const report = summarizeCapabilities(capability('test'));
    expect(report.expected_environment_matches).toBe(false);
    expect(report.financial_operations_authorized).toBe(false);
  });
  it('does not emit provider errors, account details or credentials', async () => {
    const fetcher = vi.fn().mockRejectedValue(Error('private credential in network error'));
    await expect(inspectCapabilities({key:'ozav_sk_live_synthetic',fetcher})).rejects.toThrow('OZAV_READINESS_CONNECTION_UNCONFIRMED');
    fetcher.mockResolvedValue(Response.json({error:'private credential'}, {status:403}));
    await expect(inspectCapabilities({key:'ozav_sk_live_synthetic',fetcher})).rejects.toThrow('OZAV_READINESS_REQUEST_REFUSED');
    const report = summarizeCapabilities({...capability(),email:'private@example.test',api_key:'private'});
    expect(JSON.stringify(report)).not.toMatch(/private|api_key|email/);
  });
  it('rejects malformed features, oversized bodies and non JSON without leaking their content', async () => {
    expect(()=>summarizeCapabilities({...capability(),features:{wallets:'unknown'}})).toThrow('OZAV_CAPABILITIES_INVALID');
    for (const body of ['private secret', 'x'.repeat(65537)]) {
      const fetcher = vi.fn().mockResolvedValue(new Response(body));
      await expect(inspectCapabilities({key:'ozav_sk_live_synthetic',fetcher})).rejects.toThrow('OZAV_CAPABILITIES_INVALID');
    }
  });
});
