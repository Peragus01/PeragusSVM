const statuses = new Set(['live', 'beta', 'coming_soon']);
const labels = /^[a-z][a-z0-9_:-]{0,79}$/;
function values(input) {
  if (!Array.isArray(input) || input.length > 200 || input.some(v => typeof v !== 'string' || !labels.test(v)))
    throw new Error('OZAV_CAPABILITIES_INVALID');
  return [...new Set(input)].sort();
}
export function summarizeCapabilities(input, expectedEnvironment = 'live') {
  if (!['test', 'live'].includes(expectedEnvironment)) throw new Error('OZAV_EXPECTED_ENVIRONMENT_INVALID');
  if (!input || typeof input !== 'object' || !['test', 'live'].includes(input.environment))
    throw new Error('OZAV_CAPABILITIES_INVALID');
  const entitlements = values(input.entitlements), scopes = values(input.scopes);
  if (!input.features || Array.isArray(input.features) || typeof input.features !== 'object' || Object.keys(input.features).length > 200)
    throw new Error('OZAV_CAPABILITIES_INVALID');
  const features = {};
  for (const [key, status] of Object.entries(input.features)) {
    if (!labels.test(key) || !statuses.has(status)) throw new Error('OZAV_CAPABILITIES_INVALID');
    features[key] = status;
  }
  const requiredEntitlements = ['customers', 'compliance', 'liquidity', 'custody'];
  const requiredScopes = ['customers:read', 'customers:write', 'verifications:read', 'verifications:write',
    'screenings:read', 'screenings:write', 'quotes:write', 'transfers:read', 'transfers:write', 'wallets:read'];
  return {
    environment: input.environment,
    expected_environment_matches: input.environment === expectedEnvironment,
    entitlements, scopes, features,
    missing_baseline_entitlements: requiredEntitlements.filter(v => !entitlements.includes(v)),
    missing_baseline_scopes: requiredScopes.filter(v => !scopes.includes(v)),
    // Scope checklist is an integration baseline, not a complete or sufficient live authorization.
    financial_operations_authorized: false,
    hosted_capture_verified: false,
    solana_usdt_route_verified: false,
    fees_and_net_delivery_verified: false,
  };
}

export async function inspectCapabilities({key, expectedEnvironment = 'live', fetcher = fetch}) {
  if (!['test', 'live'].includes(expectedEnvironment)) throw new Error('OZAV_EXPECTED_ENVIRONMENT_INVALID');
  if (typeof key !== 'string' || !/^ozav_sk_(test|live)_[A-Za-z0-9_-]+$/.test(key))
    throw new Error('OZAV_READINESS_KEY_REQUIRED');
  if (!key.startsWith(`ozav_sk_${expectedEnvironment}_`)) throw new Error('OZAV_KEY_ENVIRONMENT_MISMATCH');
  let response;
  try {
    response = await fetcher('https://developers.ozav.io/v2/capabilities', {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: {'X-API-Key': key, Accept: 'application/json'},
    });
  } catch { throw new Error('OZAV_READINESS_CONNECTION_UNCONFIRMED'); }
  if (!response.ok) throw new Error('OZAV_READINESS_REQUEST_REFUSED');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('OZAV_CAPABILITIES_INVALID');
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new Error(); }
      chunks.push(Buffer.from(value));
    }
    return summarizeCapabilities(JSON.parse(Buffer.concat(chunks).toString('utf8')), expectedEnvironment);
  } catch { throw new Error('OZAV_CAPABILITIES_INVALID'); }
  finally { reader.releaseLock(); }
}
