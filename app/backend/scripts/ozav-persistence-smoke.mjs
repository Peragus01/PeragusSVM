import "dotenv/config";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { OzavClient } from "../dist/providers/ozav-client.js";
import { OzavPersistenceError } from "../dist/domain/ozav-onramp.js";
import { ImportOzavOnrampEventsService } from "../dist/application/import-ozav-onramp-events.js";
import { ReconcileOzavOnrampService } from "../dist/application/reconcile-ozav-onramp.js";
import { TransitionSettlementService } from "../dist/application/transition-settlement.js";
import { PostgresOzavOnrampRepository } from "../dist/repositories/postgres-ozav-onramp-repository.js";
import { PostgresOzavOnrampIntentRepository } from "../dist/repositories/postgres-ozav-onramp-intent-repository.js";
import { PostgresSettlementRepository } from "../dist/repositories/postgres-settlement-repository.js";

async function insertDemoSettlement(connection, id) {
  const payload = {
    requestId: `ozav-persistence-smoke-${id}`, corridorId: "ab".repeat(32),
    payerWallet: "11111111111111111111111111111112",
    recipientWallet: "eD4c59FhMTkPQHBY84n8oc2YcHrAWjrn9khAL2FDBxR",
    // Arbitrary contract-unit placeholders for this rolled-back database test.
    // They are NOT a conversion of BRL 500 or USDT 89.55.
    sourceAmount: "1", destinationAmount: "1",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  await connection.query(`
    insert into settlements (
      id, request_id, request_payload_hash, request_payload, corridor_id, payer_wallet,
      recipient_wallet, source_amount, destination_amount, expires_at, status
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'created')
  `, [id, payload.requestId, hash, payload, payload.corridorId, payload.payerWallet,
    payload.recipientWallet, payload.sourceAmount, payload.destinationAmount, payload.expiresAt]);
}

let pool;
let connection;
let inTransaction = false;
try {
  const { DATABASE_URL: databaseUrl, OZAV_API_KEY: apiKey, OZAV_TRANSFER_ID: transferId,
    OZAV_CUSTOMER_ID: customerId, OZAV_WALLET_ID: walletId } = process.env;
  if (!databaseUrl || !apiKey || !transferId || !customerId || !walletId) {
    throw new Error("Configure DATABASE_URL e os quatro identificadores OZAV no .env");
  }
  const client = new OzavClient({ apiKey });
  const transfer = await client.getTransfer(transferId);
  if (!transfer.quoteId) throw new Error("O on-ramp precisa de uma quote_id");
  pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10_000,
    ...(process.env.DATABASE_SSL === "true" ? { ssl: { rejectUnauthorized: false } } : {}) });
  connection = await pool.connect();
  const protectedTables = await connection.query(`
    select c.relname, c.relrowsecurity from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (
        'settlement_ozav_onramps',
        'settlement_ozav_events',
        'settlement_ozav_onramp_intents'
      )
  `);
  assert.equal(protectedTables.rowCount, 3, "Execute npm run db:migrate primeiro");
  assert(protectedTables.rows.every((row) => row.relrowsecurity), "RLS precisa estar habilitado");
  const existing = await connection.query(`
    select settlement_id from settlement_ozav_onramps where transfer_id = $1
  `, [transferId]);
  assert.equal(existing.rowCount, 0, "A transferencia ja possui um vinculo persistente; use outra transferencia para este teste");

  const settlementId = randomUUID();
  const binding = { settlementId, transferId, customerId, walletId, quoteId: transfer.quoteId };
  await connection.query("begin");
  inTransaction = true;
  await insertDemoSettlement(connection, settlementId);
  const repository = new PostgresOzavOnrampRepository(connection);
  const intentRepository =
    new PostgresOzavOnrampIntentRepository(connection);
  const settlements = new PostgresSettlementRepository(connection);
  const intentRequest = {
    settlementId,
    customerId,
    walletId,
    sourceAmountBrl: transfer.amounts.source.amount,
    spreadBps: 0,
    idempotencyKey:
      `peragus_smoke_${settlementId.replaceAll("-", "")}`,
  };
  const reservedIntent =
    await intentRepository.reserve(intentRequest);
  assert.equal(reservedIntent.created, true);
  const quotedIntent = await intentRepository.saveQuote({
    settlementId,
    quoteId: transfer.quoteId,
    quoteTargetAmountUsdt:
      transfer.amounts.target.amount,
    updatedAt: new Date(),
  });
  assert.equal(quotedIntent.quoteId, transfer.quoteId);
  const payment = transfer.source.paymentInstructions;
  assert(payment, "A transferencia precisa conter instrucoes Pix");
  const paymentRequest = {
    settlementId,
    paymentInstructions: {
      transferId,
      intentId: payment.intentId,
      brCode: payment.brCode,
      qrCodeImage: payment.qrCodeImage,
      expiresAt: new Date(payment.expiresAt),
    },
    updatedAt: new Date(),
  };
  const instructedIntent =
    await intentRepository.savePaymentInstructions(
      paymentRequest,
    );
  assert.equal(
    instructedIntent.paymentInstructions?.transferId,
    transferId,
  );
  const instructedReplay =
    await intentRepository.savePaymentInstructions(
      paymentRequest,
    );
  assert.equal(
    instructedReplay.paymentInstructions?.transferId,
    transferId,
  );
  await assert.rejects(
    () => intentRepository.savePaymentInstructions({
      ...paymentRequest,
      paymentInstructions: {
        ...paymentRequest.paymentInstructions,
        transferId: "ozav_tr_conflict_probe",
      },
    }),
    /different OZAV payment instructions/,
  );
  const intentReplay =
    await intentRepository.reserve(intentRequest);
  assert.equal(intentReplay.created, false);
  assert.equal(intentReplay.intent.quoteId, transfer.quoteId);
  await assert.rejects(
    () => intentRepository.reserve({
      ...intentRequest,
      sourceAmountBrl: "501",
    }),
    /different OZAV on-ramp intent/,
  );
  const service = new ImportOzavOnrampEventsService({ client, repository, settlements });
  console.log("Importando eventos no teste transacional...");
  const first = await service.execute(binding);
  assert(first.inserted > 0, "Nenhum evento foi importado");
  assert.equal(first.bindingCreated, true);
  console.log("Repetindo a importacao para verificar deduplicacao...");
  const replay = await service.execute(binding);
  assert.equal(replay.bindingCreated, false);
  assert.equal(replay.inserted, 0);
  assert.equal(replay.duplicates, replay.eventsFound);
  const stored = await repository.listEvents(settlementId);
  assert.equal(stored.length, first.inserted);
  const settlement = await settlements.findById(settlementId);
  assert.equal(settlement?.status, "created", "A importacao nao pode avancar o settlement");
  assert.equal(settlement?.version, 0);
  const unprocessed = await connection.query(`
    select count(*)::int as count from settlement_ozav_events
    where settlement_id = $1 and processed_at is null
  `, [settlementId]);
  assert.equal(unprocessed.rows[0].count, stored.length);

  const reconciler = new ReconcileOzavOnrampService({
    importer: service,
    ozavRepository: repository,
    settlements,
    transitioner: new TransitionSettlementService(settlements),
  });
  console.log("Reconciliando o estado atual da OZAV com o settlement...");
  const reconciled = await reconciler.execute(settlementId);
  assert.deepEqual(reconciled.transitions, ["awaiting_pix", "pix_confirmed", "tokenized"]);
  assert.equal(reconciled.settlementStatus, "tokenized");
  assert.equal(reconciled.eventsProcessed, stored.length);
  const reconciledSettlement = await settlements.findById(settlementId);
  assert.equal(reconciledSettlement?.status, "tokenized");
  assert.equal(reconciledSettlement?.version, 3);
  const reconciliationReplay = await reconciler.execute(settlementId);
  assert.deepEqual(reconciliationReplay.transitions, []);
  assert.equal(reconciliationReplay.eventsProcessed, 0);
  const afterReplay = await settlements.findById(settlementId);
  assert.equal(afterReplay?.status, "tokenized");
  assert.equal(afterReplay?.version, 3);
  const remainingUnprocessed = await connection.query(`
    select count(*)::int as count from settlement_ozav_events
    where settlement_id = $1 and processed_at is null
  `, [settlementId]);
  assert.equal(remainingUnprocessed.rows[0].count, 0);

  const firstStored = stored[0];
  const tampered = { id: firstStored.eventId, type: firstStored.eventType,
    createdAt: firstStored.occurredAt, transfer: { ...transfer, status: "smoke_conflict_probe" } };
  await assert.rejects(() => repository.recordEvent(binding, tampered), OzavPersistenceError);
  await assert.rejects(() => repository.createBinding({ ...binding, quoteId: "ozav_q_conflict_probe" }), OzavPersistenceError);

  // Verify the unique transfer constraint with a second settlement; restore the
  // transaction after the deliberate SQL constraint error.
  await connection.query("savepoint unique_transfer_probe");
  try {
    const otherSettlementId = randomUUID();
    await insertDemoSettlement(connection, otherSettlementId);
    await assert.rejects(() => repository.createBinding({ ...binding, settlementId: otherSettlementId }),
      (error) => error instanceof OzavPersistenceError && error.message.includes("already linked"));
  } finally {
    await connection.query("rollback to savepoint unique_transfer_probe");
  }

  await connection.query("rollback");
  inTransaction = false;
  const leftovers = await connection.query(`
    select
      (select count(*) from settlements where id = $1)::int as settlements,
      (select count(*) from settlement_ozav_onramp_intents
        where settlement_id = $1)::int as intents,
      (select count(*) from settlement_ozav_onramps where settlement_id = $1)::int as bindings,
      (select count(*) from settlement_ozav_events where settlement_id = $1)::int as events
  `, [settlementId]);
  assert.deepEqual(leftovers.rows[0], {
    settlements: 0,
    intents: 0,
    bindings: 0,
    events: 0,
  });
  console.log("PERSISTENCIA OZAV COM POSTGRESQL: OK");
  console.table([{ transfer_id: transferId, eventos_inseridos: first.inserted,
    repetidos_no_replay: replay.duplicates, status_settlement: reconciledSettlement.status,
    transicoes_aplicadas: reconciled.transitions.join(" -> "),
    eventos_processados: reconciled.eventsProcessed,
    intencao_idempotente: !intentReplay.created,
    pix_persistido:
      instructedIntent.paymentInstructions !== null,
    pix_idempotente:
      instructedReplay.paymentInstructions?.transferId
        === transferId,
    conflito_de_evento_bloqueado: true, transferencia_unica: true, rollback_confirmado: true }]);
  console.log("Somente as tabelas da migration permanecem; os registros de teste foram revertidos.");
} catch (error) {
  console.error("FALHA:", error instanceof Error ? error.message : "Erro inesperado");
  process.exitCode = 1;
} finally {
  if (inTransaction && connection) {
    await connection.query("rollback").catch(() => undefined);
  }
  connection?.release();
  if (pool) await pool.end();
}
