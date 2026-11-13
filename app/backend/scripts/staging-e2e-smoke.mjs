#!/usr/bin/env node
// End-to-end smoke against the deployed STAGING API (test mode, solana:devnet, OZAV sandbox).
// Journey: guard -> operator switches ON -> daily review -> legal -> onboarding/KYC (simulated)
// -> wallet check -> quote R$1000 -> accept -> Pix -> simulate payment -> withdrawal request
// -> approve -> execute -> delivery -> final status. Switches turned ON are turned OFF in finally.
// Inputs come only from env vars. Prints step names, HTTP status, ids and statuses; never tokens
// or personal data. Docs: docs/operations/staging-smoke.md
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { assertStagingSafe, normalizeBase, SmokeGuardError } from "./lib/staging-smoke-guard.mjs";

const env = process.env;
const args = new Set(process.argv.slice(2));
const SKIP_WALLET = args.has("--skip-wallet") || env.STAGING_SKIP_WALLET_CHECK === "1";
const STEP_TIMEOUT_MS = Math.max(10, Number(env.STAGING_SMOKE_STEP_TIMEOUT_SECONDS ?? 180)) * 1000;
const REQUEST_TIMEOUT_MS = 20000;
const POLL_MS = Number(env.STAGING_SMOKE_POLL_INTERVAL_MS ?? 3000);
const QUOTE_BRL = "1000.00";
const SWITCHES = ["onboarding", "new_operations", "usdt_sends"];

class StepError extends Error {
  constructor(step, message) {
    super(message);
    this.step = step;
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => console.log(line);

// ---- HTTP -----------------------------------------------------------------------------------
let API = "";
async function http(step, method, path, { token, body, ok = [200, 201], allow = [] } = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new StepError(step, `falha de rede ou timeout em ${method} ${path}`);
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    /* empty or non-JSON body */
  }
  const code = json?.error?.code;
  log(`  ${method} ${path.split("?")[0]} -> ${response.status}${code ? ` ${code}` : ""}`);
  if (!ok.includes(response.status) && !allow.includes(code))
    throw new StepError(step, `${method} ${path.split("?")[0]} respondeu ${response.status}${code ? ` (${code})` : ""}`);
  return { status: response.status, json, code };
}

// ---- tokens ---------------------------------------------------------------------------------
const customerToken = () => env.STAGING_CUSTOMER_TOKEN ?? "";
function readOperatorToken() {
  if (env.STAGING_OPERATOR_TOKEN_FILE) {
    try {
      return readFileSync(env.STAGING_OPERATOR_TOKEN_FILE, "utf8").trim();
    } catch {
      return "";
    }
  }
  return operatorTokenCache;
}
let operatorTokenCache = (env.STAGING_OPERATOR_TOKEN ?? "").trim();

async function askLine(question) {
  if (!process.stdin.isTTY) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Mute echo so a pasted token never lands in the terminal scrollback.
  const out = rl.output;
  rl._writeToOutput = (text) => {
    if (text.includes(question)) out.write(text);
  };
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  out.write("\n");
  return answer.trim();
}

/** Called after OPERATOR_MFA_STALE: obtain a token with a fresh TOTP (file re-read or prompt). */
async function refreshOperatorToken(step) {
  if (env.STAGING_OPERATOR_TOKEN_FILE) {
    const answer = await askLine(
      `  [${step}] MFA expirou. Atualize o arquivo STAGING_OPERATOR_TOKEN_FILE com um token recente e pressione Enter: `,
    );
    if (answer === null) throw new StepError(step, "OPERATOR_MFA_STALE e entrada interativa indisponivel (sem TTY)");
    return;
  }
  const answer = await askLine(`  [${step}] MFA expirou. Cole um token de operador com TOTP recente e pressione Enter: `);
  if (answer === null) throw new StepError(step, "OPERATOR_MFA_STALE e entrada interativa indisponivel (sem TTY)");
  if (!answer) throw new StepError(step, "token de operador nao informado");
  operatorTokenCache = answer;
}

/** Operator call; on OPERATOR_MFA_STALE refreshes the token and repeats ONCE with the same body. */
async function operatorHttp(step, method, path, options = {}) {
  const run = () => http(step, method, path, { ...options, token: readOperatorToken(), allow: [...(options.allow ?? []), "OPERATOR_MFA_STALE"] });
  let result = await run();
  if (result.code === "OPERATOR_MFA_STALE") {
    await refreshOperatorToken(step);
    result = await http(step, method, path, { ...options, token: readOperatorToken() });
  }
  return result;
}

// ---- helpers --------------------------------------------------------------------------------
async function poll(step, fn, { timeoutMs = STEP_TIMEOUT_MS, describe = "condicao" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() + POLL_MS > deadline) throw new StepError(step, `timeout aguardando ${describe} (${Math.round(timeoutMs / 1000)}s)`);
    await sleep(POLL_MS);
  }
}

const saoPauloDay = (offsetDays) => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86400000));
  return parts; // YYYY-MM-DD
};

let currentStep = "inicio";
// Every step is raced against a deadline. A timeout becomes a StepError (not process.exit),
// so the finally in main() still turns the switches back OFF.
async function step(name, fn, timeoutMs = STEP_TIMEOUT_MS + 60000) {
  currentStep = name;
  log(`[etapa] ${name}`);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new StepError(name, `estourou o tempo limite da etapa (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
  });
  try {
    return await Promise.race([fn(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- runtime switches -------------------------------------------------------------------------
const turnedOn = [];
async function setSwitch(stepName, key, enabled, reason) {
  const result = await operatorHttp(stepName, "PUT", "/v1/admin/runtime-controls", { body: { key, enabled, reason }, ok: [200] });
  log(`  chave ${key} enabled=${result.json?.data?.enabled} changed=${result.json?.data?.changed}`);
}

async function turnSwitchesOff() {
  for (const key of [...turnedOn].reverse()) {
    try {
      await setSwitch(`desligar chave ${key}`, key, false, "Fim do smoke de staging: restaurando chave desligada");
      turnedOn.splice(turnedOn.indexOf(key), 1);
    } catch (error) {
      console.error(`ATENCAO: nao foi possivel desligar a chave ${key} (${error.message}). Desligue-a no console do operador.`);
      process.exitCode = 1;
    }
  }
}

// ---- onboarding ------------------------------------------------------------------------------
async function onboarding(token) {
  const seen = new Map();
  for (let i = 0; i < 20; i += 1) {
    const { json } = await http("onboarding", "GET", "/v1/me/onboarding/status", { token });
    const status = json?.data ?? {};
    const pending = (status.pending_steps ?? []).filter((s) => !(SKIP_WALLET && s === "WALLET_OWNERSHIP_REQUIRED"));
    log(`  review_state=${status.review_state} pendentes=${pending.join(",") || "nenhum"}`);
    if (!pending.length) return status;
    const first = pending[0];
    const count = (seen.get(first) ?? 0) + 1;
    seen.set(first, count);
    if (count > 6) throw new StepError("onboarding", `etapa ${first} nao avancou apos ${count - 1} tentativas`);
    switch (first) {
      case "WALLET_OWNERSHIP_REQUIRED":
        throw new StepError("onboarding", "carteira devnet nao vinculada: vincule pelo app (assinatura de mensagem exige a chave privada) ou use --skip-wallet se ja estiver vinculada");
      case "INDIVIDUAL_DRAFT_REQUIRED":
        throw new StepError("onboarding", "cadastro individual (rascunho) ausente: preencha com dados sinteticos pelo app; o smoke nao inventa dados pessoais");
      case "PROVIDER_TERMS_REQUIRED":
      case "PROVIDER_TERMS_RENEWAL_REQUIRED":
        await http("onboarding/termos", "POST", "/v1/me/onboarding/terms", { token, body: first === "PROVIDER_TERMS_RENEWAL_REQUIRED" && status.provider_terms?.session_id ? { renew_session_id: status.provider_terms.session_id } : {} });
        break;
      case "PROVIDER_TERMS_ACCEPTANCE_REQUIRED":
      case "PROVIDER_TERMS_RECOVERY_REQUIRED":
        await http("onboarding/termos", "POST", "/v1/me/onboarding/terms/accept", { token, body: { session_id: status.provider_terms?.session_id, accepted: true } });
        break;
      case "PROVIDER_SUBMISSION_REQUIRED":
        await http("onboarding/envio", "POST", "/v1/me/onboarding/submit", { token, body: { draft_version: status.draft?.version, terms_session_id: status.provider_terms?.session_id, sandbox_data_confirmed: true } });
        break;
      case "PROVIDER_SUBMISSION_PENDING":
      case "PROVIDER_STATUS_NOT_APPROVED":
      case "PROVIDER_VERIFICATION_MODE_REVIEW_REQUIRED":
      case "PROVIDER_REQUIREMENTS_PENDING":
      case "PROVIDER_REQUIREMENTS_UNKNOWN":
        await http("onboarding/atualizar", "POST", "/v1/me/onboarding/refresh", { token, body: {} });
        await sleep(POLL_MS);
        break;
      case "IDENTITY_VERIFICATION_REQUIRED":
        await http("onboarding/kyc", "POST", "/v1/me/onboarding/verification", { token, body: {} });
        break;
      case "IDENTITY_VERIFICATION_PENDING":
        await http("onboarding/kyc-simulado", "POST", "/v1/me/onboarding/verification/simulate", { token, body: { outcome: "approved" } });
        await http("onboarding/kyc", "POST", "/v1/me/onboarding/verification/refresh", { token, body: {} });
        break;
      case "IDENTITY_VERIFICATION_REJECTED":
        throw new StepError("onboarding", "verificacao de identidade rejeitada");
      case "SCREENING_REQUIRED":
        await http("onboarding/triagem", "POST", "/v1/me/onboarding/screening", { token, body: {} });
        break;
      case "SCREENING_PENDING":
        await http("onboarding/triagem", "POST", "/v1/me/onboarding/screening/refresh", { token, body: {} });
        await sleep(POLL_MS);
        break;
      default:
        throw new StepError("onboarding", `pendencia sem automacao: ${first}`);
    }
  }
  throw new StepError("onboarding", "onboarding nao concluiu em 20 iteracoes");
}

// ---- main ------------------------------------------------------------------------------------
async function journey() {
  const customer = customerToken();
  const ids = {};

  await step("guarda (modo do alvo)", async () => {
    API = normalizeBase(env.STAGING_API_BASE_URL);
    await assertStagingSafe({ env, apiBase: env.STAGING_API_BASE_URL, customerToken: customer });
    log("  alvo confirmado: environment=test network=solana:devnet");
  });
  if (!readOperatorToken()) throw new StepError("entradas", "informe STAGING_OPERATOR_TOKEN (ou STAGING_OPERATOR_TOKEN_FILE)");

  await step("chaves de runtime: ler estado", async () => {
    const { json } = await operatorHttp("chaves de runtime: ler estado", "GET", "/v1/admin/runtime-controls", { ok: [200] });
    const states = new Map((json?.data?.controls ?? []).map((c) => [c.key, c.enabled]));
    ids.alreadyOn = SWITCHES.filter((k) => states.get(k) === true);
    log(`  ja ligadas antes do smoke: ${ids.alreadyOn.join(",") || "nenhuma"}`);
  });

  await step("chaves de runtime: ligar onboarding, new_operations, usdt_sends", async () => {
    for (const key of SWITCHES) {
      if (ids.alreadyOn.includes(key)) continue;
      turnedOn.push(key); // registered first so finally always tries to restore it
      await setSwitch("chaves de runtime: ligar", key, true, "Smoke de staging ponta a ponta: ligando chave temporariamente");
    }
  });

  await step("revisao diaria de ontem (se exigida)", async () => {
    const day = saoPauloDay(-1);
    const { json } = await operatorHttp("revisao diaria de ontem (se exigida)", "GET", `/v1/admin/daily-reviews?day=${day}`, { ok: [200] });
    const data = json?.data ?? {};
    log(`  dia=${day} reviewed=${data.reviewed} has_activity=${data.has_activity}`);
    if (data.has_activity && !data.reviewed) {
      await operatorHttp("revisao diaria de ontem (se exigida)", "POST", "/v1/admin/daily-reviews", { body: { day, note: "Smoke de staging: revisao do dia anterior" }, ok: [200] });
    }
  });

  await step("aceite juridico", async () => {
    const { json } = await http("aceite juridico", "GET", "/v1/me/legal-acceptances", { token: customer, ok: [200] });
    const missing = json?.data?.missing ?? [];
    log(`  documentos pendentes: ${missing.map((d) => d.document).join(",") || "nenhum"}`);
    if (missing.length)
      await http("aceite juridico", "POST", "/v1/me/legal-acceptances", { token: customer, body: { documents: missing.map((d) => ({ document: d.document, version: d.version })) }, ok: [201] });
  });

  await step("onboarding e KYC simulado", async () => {
    await onboarding(customer);
  });

  await step("carteira devnet vinculada", async () => {
    if (SKIP_WALLET) return log("  verificacao ignorada (--skip-wallet)");
    const { json } = await http("carteira devnet vinculada", "GET", "/v1/me/wallet", { token: customer, ok: [200] });
    if (!json?.data) throw new StepError("carteira devnet vinculada", "nenhuma carteira vinculada");
    log("  carteira vinculada e verificada");
  });

  const withDailyReview = async (stepName, run) => {
    const result = await run();
    if (result.code === "DAILY_REVIEW_REQUIRED" && result.json?.error?.day) {
      await operatorHttp(stepName, "POST", "/v1/admin/daily-reviews", { body: { day: result.json.error.day, note: "Smoke de staging: revisao exigida" }, ok: [200] });
      return run();
    }
    return result;
  };

  await step("cotacao R$ 1.000,00", async () => {
    const requestId = randomUUID();
    const result = await withDailyReview("cotacao R$ 1.000,00", () =>
      http("cotacao R$ 1.000,00", "POST", "/v1/me/quotes", { token: customer, body: { request_id: requestId, source_amount_brl: QUOTE_BRL }, ok: [200, 201], allow: ["DAILY_REVIEW_REQUIRED"] }),
    );
    if (![200, 201].includes(result.status)) throw new StepError("cotacao R$ 1.000,00", `cotacao recusada (${result.code})`);
    ids.quote = result.json?.data?.id;
    log(`  quote_id=${ids.quote}`);
  });

  await step("aceite da cotacao (purchase intent)", async () => {
    const result = await withDailyReview("aceite da cotacao (purchase intent)", () =>
      http("aceite da cotacao (purchase intent)", "POST", "/v1/me/purchase-intents", { token: customer, body: { request_id: randomUUID(), quote_id: ids.quote }, ok: [200, 201], allow: ["DAILY_REVIEW_REQUIRED"] }),
    );
    if (![200, 201].includes(result.status)) throw new StepError("aceite da cotacao (purchase intent)", `aceite recusado (${result.code})`);
    ids.purchase = result.json?.data?.id;
    log(`  purchase_intent_id=${ids.purchase}`);
  });

  await step("Pix: criar", async () => {
    const result = await withDailyReview("Pix: criar", () =>
      http("Pix: criar", "POST", "/v1/me/pix", { token: customer, body: { request_id: randomUUID(), purchase_intent_id: ids.purchase }, ok: [200, 201, 202], allow: ["DAILY_REVIEW_REQUIRED"] }),
    );
    if (![200, 201, 202].includes(result.status)) throw new StepError("Pix: criar", `Pix recusado (${result.code})`);
    if (result.json?.data?.recovery_required) throw new StepError("Pix: criar", "Pix com resultado incerto (recovery_required): nao repetir; investigar");
    ids.pix = result.json?.data?.id;
    log(`  pix_id=${ids.pix} state=${result.json?.data?.state}`);
  });

  await step("Pix: simular pagamento (sandbox)", async () => {
    const result = await http("Pix: simular pagamento (sandbox)", "POST", `/v1/me/pix/${ids.pix}/simulate`, { token: customer, ok: [200, 202] });
    if (result.json?.data?.recovery_required) throw new StepError("Pix: simular pagamento (sandbox)", "simulacao com resultado incerto (recovery_required)");
  });

  await step("Pix: aguardar conversao concluida", async () => {
    await poll("Pix: aguardar conversao concluida", async () => {
      const { json } = await http("Pix: aguardar conversao concluida", "POST", `/v1/me/pix/${ids.pix}/reconcile`, { token: customer, ok: [200] });
      const data = json?.data ?? {};
      log(`  state=${data.state} payment_confirmed=${data.payment_confirmed} custody_conversion_completed=${data.custody_conversion_completed}`);
      if (["failed", "cancelled", "expired", "needs_review"].includes(data.state)) throw new StepError("Pix: aguardar conversao concluida", `Pix terminou em ${data.state}`);
      return data.custody_conversion_completed === true;
    }, { describe: "conversao do Pix" });
  });

  await step("pedido de saque (registro)", async () => {
    const { json } = await http("pedido de saque (registro)", "POST", "/v1/me/withdrawal-requests", { token: customer, body: { request_id: randomUUID(), pix_id: ids.pix }, ok: [200, 201] });
    ids.withdrawal = json?.data?.id;
    log(`  withdrawal_request_id=${ids.withdrawal}`);
  });

  await step("aguardar awaiting_approval e aprovar (operador)", async () => {
    const requestId = randomUUID();
    const waiting = new Set(["WITHDRAWAL_OPERATION_NOT_AWAITING_APPROVAL", "WITHDRAWAL_APPROVAL_PREREQUISITES_REQUIRED"]);
    await poll("aguardar awaiting_approval e aprovar (operador)", async () => {
      const result = await operatorHttp("aguardar awaiting_approval e aprovar (operador)", "POST", `/v1/admin/withdrawal-requests/${ids.withdrawal}/approval`, {
        body: { request_id: requestId, reason: "Smoke de staging: conferido Pix, trava e carteira de teste" },
        ok: [200, 201],
        allow: [...waiting],
      });
      if ([200, 201].includes(result.status)) return true;
      log("  operacao ainda nao esta awaiting_approval; aguardando");
      return false;
    }, { describe: "operacao em awaiting_approval" });
  });

  await step("executar envio (aguarda intervalo minimo)", async () => {
    const requestId = randomUUID();
    const result = await poll("executar envio (aguarda intervalo minimo)", async () => {
      const r = await operatorHttp("executar envio (aguarda intervalo minimo)", "POST", `/v1/admin/withdrawal-requests/${ids.withdrawal}/execution`, {
        body: { request_id: requestId, confirmation: "SANDBOX_ONLY" },
        ok: [200, 201, 202],
        allow: ["EXECUTION_TOO_EARLY"],
      });
      if (r.code === "EXECUTION_TOO_EARLY") {
        const remaining = Number(r.json?.error?.remaining_delay_seconds ?? 0);
        log(`  intervalo minimo: faltam ${remaining}s`);
        await sleep(Math.min(Math.max(remaining, 1), 60) * 1000);
        return false;
      }
      return r;
    }, { timeoutMs: Math.max(STEP_TIMEOUT_MS, 1000 * 960), describe: "fim do intervalo minimo de execucao" });
    log(`  execucao state=${result.json?.data?.state} recovery_required=${result.json?.data?.recovery_required}`);
  }, 1000 * 1080);

  let execution = null;
  await step("aguardar entrega (sent/delivered_verified ou simulada)", async () => {
    execution = await poll("aguardar entrega (sent/delivered_verified ou simulada)", async () => {
      const { json } = await operatorHttp("aguardar entrega (sent/delivered_verified ou simulada)", "POST", `/v1/admin/withdrawal-requests/${ids.withdrawal}/execution/reconcile`, { ok: [200] });
      const data = json?.data ?? {};
      log(`  state=${data.state} provider_completed=${data.provider_completed} delivery_status=${data.delivery_status} verified=${data.onchain_delivery_verified}`);
      if (data.manual_review_required) throw new StepError("aguardar entrega (sent/delivered_verified ou simulada)", `envio em revisao manual (delivery_status=${data.delivery_status}, reason=${data.delivery_reason ?? "n/a"})`);
      return data.delivery_status === "verified" || data.delivery_status === "simulated" ? data : null;
    }, { timeoutMs: Math.max(STEP_TIMEOUT_MS, 300000), describe: "entrega do USDT" });
  }, Math.max(STEP_TIMEOUT_MS, 300000) + 60000);

  await step("status final e conciliacao", async () => {
    const { json } = await http("status final e conciliacao", "GET", `/v1/me/operations/${ids.purchase}`, { token: customer, ok: [200] });
    const op = json?.data ?? {};
    log(`  operacao ${ids.purchase}: stage=${op.stage} withdrawal.state=${op.withdrawal?.state} onchain_delivery_verified=${op.onchain_delivery_verified} delivery_simulated=${op.delivery_simulated}`);
    log(`  conciliacao do envio: delivery_status=${execution?.delivery_status} provider_completed=${execution?.provider_completed} onchain_delivery_verified=${execution?.onchain_delivery_verified} reason=${execution?.delivery_reason ?? "n/a"}`);
    const delivered = op.onchain_delivery_verified === true || op.delivery_simulated === true;
    if (!delivered) throw new StepError("status final e conciliacao", "a operacao nao aparece como entregue (verificada ou simulada)");
  });

  log(`RESULTADO: SUCESSO (quote=${ids.quote} purchase=${ids.purchase} pix=${ids.pix} withdrawal=${ids.withdrawal})`);
}

async function main() {
  try {
    await journey();
  } catch (error) {
    if (error instanceof SmokeGuardError) console.error(`${error.message} [${error.code}]`);
    else if (error instanceof StepError) console.error(`FALHA na etapa "${error.step}": ${error.message}`);
    else console.error(`FALHA na etapa "${currentStep}": erro inesperado (${error?.name ?? "Error"})`);
    process.exitCode = 1;
  } finally {
    if (turnedOn.length) {
      currentStep = "desligar chaves";
      log("[etapa] desligar chaves ligadas pelo smoke");
      await turnSwitchesOff();
    }
  }
}

await main();
process.exit(process.exitCode ?? 0);
