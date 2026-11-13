// Read-only probe of the OZAV live key: GET /v2/capabilities only. Never prints the key.
// Usage: OZAV_LIVE_PROBE_API_KEY=<live key> node scripts/ozav-live-capabilities.mjs
// Exit codes: 0 = environment live and no required capability clearly absent;
//             1 = wrong environment, required capability absent, or probe failure.
import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE_URL = 'https://developers.ozav.io/v2';
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 65_536;
const LABEL = /^[a-z][a-z0-9_:.-]{0,79}$/;

export const PRESENT = 'presente';
export const ABSENT = 'ausente';
export const UNKNOWN = 'não informado';

// GET-only HTTP layer: refuses any other method at code level, never follows redirects.
export function createGetOnlyHttp(fetcher = fetch, timeoutMs = TIMEOUT_MS) {
  return async function request(url, { method = 'GET', headers = {} } = {}) {
    if (method !== 'GET') throw new Error('OZAV_PROBE_METHOD_REFUSED');
    return fetcher(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(timeoutMs) });
  };
}

function labels(value) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter(v => typeof v === 'string' && LABEL.test(v)))].sort();
}

// Capability -> fields of GET /v2/capabilities (entitlements, scopes, features) that evidence it.
// `unreportable`: the response has no field that can prove it; the best answer is "não informado".
export const REQUIRED_CAPABILITIES = [
  { id: 'onramp_brl_usdt_solana', label: 'On-ramp BRL (Pix) para USDT na Solana',
    entitlements: ['liquidity'], scopes: ['quotes:write', 'transfers:write', 'transfers:read'], features: ['quotes', 'transfers'],
    note: 'a rota BRL->USDT/Solana em si não aparece em /capabilities; confirmar por escrito com a OZAV' },
  { id: 'custody_wallet_transfers', label: 'Custódia gerenciada / transferências de carteira',
    entitlements: ['custody'], scopes: ['wallets:read'], features: ['wallets'] },
  { id: 'crypto_address_travel_rule', label: 'Envio para crypto_address com Travel Rule',
    entitlements: [], scopes: ['transfers:write'], features: ['transfers'], unreportable: true,
    note: 'Travel Rule não tem campo em /capabilities; confirmar por escrito com a OZAV' },
  { id: 'fx_rate_lock_facility', label: 'Facility de trava de câmbio (rate lock)',
    entitlements: [], scopes: ['quotes:write'], features: [], unreportable: true, featurePattern: /facility|rate_lock|fx_lock/,
    note: 'facility só aparece na resposta da cotação (facility_preview), não em /capabilities; confirmar contratação por escrito' },
  { id: 'hosted_kyc_session_url', label: 'KYC hospedado (session_url)',
    entitlements: ['compliance'], scopes: ['verifications:read', 'verifications:write'], features: ['verifications'],
    note: 'o session_url só existe por verificação; o host é conferido no passo seguinte' },
  { id: 'webhooks', label: 'Webhooks',
    entitlements: [], scopes: ['webhooks:read', 'webhooks:write'], features: [] },
];

export function classify(caps) {
  const entitlements = labels(caps.entitlements) ?? [];
  const scopes = labels(caps.scopes) ?? [];
  const features = caps.features && typeof caps.features === 'object' && !Array.isArray(caps.features) ? caps.features : {};
  return REQUIRED_CAPABILITIES.map(def => {
    const missing = [
      ...def.entitlements.filter(e => !entitlements.includes(e)).map(e => `entitlement ${e}`),
      ...def.scopes.filter(s => !scopes.includes(s)).map(s => `scope ${s}`),
    ];
    let unknown = def.unreportable === true;
    let featureKeys = def.features;
    if (def.featurePattern) {
      const found = Object.keys(features).filter(k => def.featurePattern.test(k));
      if (found.length) { featureKeys = found; unknown = false; }
    }
    const details = [];
    for (const key of featureKeys) {
      const status = features[key];
      if (status === 'coming_soon') missing.push(`feature ${key}=coming_soon`);
      else if (status === 'live') details.push(`feature ${key}=live`);
      else if (status === 'beta') { unknown = true; details.push(`feature ${key}=beta (pode exigir habilitação)`); }
      else { unknown = true; details.push(`feature ${key} não informada`); }
    }
    let status = PRESENT;
    if (missing.length) status = ABSENT;
    else if (unknown) status = UNKNOWN;
    return { id: def.id, label: def.label, status, missing, details, note: def.note ?? null };
  });
}

async function readCapped(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('OZAV_CAPABILITIES_INVALID');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error('too large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function probe({ key, baseUrl = DEFAULT_BASE_URL, fetcher = fetch, timeoutMs = TIMEOUT_MS }) {
  if (typeof key !== 'string' || key.length < 8) throw new Error('OZAV_PROBE_KEY_REQUIRED');
  const request = createGetOnlyHttp(fetcher, timeoutMs);
  let response;
  try {
    response = await request(`${baseUrl}/capabilities`, { headers: { 'X-API-Key': key, Accept: 'application/json' } });
  } catch { throw new Error('OZAV_PROBE_CONNECTION_UNCONFIRMED'); }
  if (!response.ok) throw new Error('OZAV_PROBE_REQUEST_REFUSED');
  let body;
  try { body = JSON.parse(await readCapped(response)); } catch { throw new Error('OZAV_CAPABILITIES_INVALID'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('OZAV_CAPABILITIES_INVALID');
  const entitlements = labels(body.entitlements), scopes = labels(body.scopes);
  if (!entitlements || !scopes) throw new Error('OZAV_CAPABILITIES_INVALID');
  const environment = body.environment === 'live' || body.environment === 'test' ? body.environment : null;
  const capabilities = classify(body);
  const failures = [];
  if (environment !== 'live') failures.push('ambiente diferente de live (chave errada)');
  for (const c of capabilities) if (c.status === ABSENT) failures.push(`ausente: ${c.label}`);
  return { environment, entitlements, scopes, capabilities, failures, ok: failures.length === 0 };
}

export function render(report) {
  const lines = [];
  lines.push(`Ambiente: ${report.environment ?? 'inválido/não informado'}`);
  lines.push(`Entitlements: ${report.entitlements.join(', ') || '(nenhum)'}`);
  lines.push(`Scopes: ${report.scopes.join(', ') || '(nenhum)'}`);
  lines.push('', 'Capacidades exigidas pelo MVP:');
  for (const c of report.capabilities) {
    const mark = c.status === PRESENT ? '[x]' : c.status === ABSENT ? '[!]' : '[?]';
    const why = [...c.missing, ...c.details].join('; ');
    lines.push(`${mark} ${c.label}: ${c.status}${why ? ` (${why})` : ''}`);
  }
  const unknown = report.capabilities.filter(c => c.status === UNKNOWN);
  if (unknown.length) {
    lines.push('', 'Não informado: pedir à OZAV, por escrito, e arquivar a resposta:');
    for (const c of unknown) lines.push(`- ${c.label}${c.note ? ` — ${c.note}` : ''}`);
  }
  lines.push('');
  if (!report.ok) lines.push('RESULTADO: FALHA', ...report.failures.map(f => `- ${f}`));
  else lines.push(unknown.length ? 'RESULTADO: OK COM PENDÊNCIAS (itens "não informado" ainda sem prova)' : 'RESULTADO: OK');
  return lines.join('\n');
}

function redact(text, key) {
  return typeof key === 'string' && key ? text.split(key).join('[redacted]') : text;
}

export async function main(env = process.env, { fetcher = fetch, out = console.log, err = console.error } = {}) {
  const key = env.OZAV_LIVE_PROBE_API_KEY;
  try {
    const report = await probe({ key, baseUrl: env.OZAV_BASE_URL || DEFAULT_BASE_URL, fetcher });
    out(redact(render(report), key));
    return report.ok ? 0 : 1;
  } catch (error) {
    const allowed = new Set(['OZAV_PROBE_KEY_REQUIRED', 'OZAV_PROBE_METHOD_REFUSED', 'OZAV_PROBE_CONNECTION_UNCONFIRMED',
      'OZAV_PROBE_REQUEST_REFUSED', 'OZAV_CAPABILITIES_INVALID']);
    err(JSON.stringify({ error: allowed.has(error?.message) ? error.message : 'OZAV_PROBE_UNCONFIRMED' }));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
