import "dotenv/config";

import {
  GetSettlementAuditService,
  SettlementAuditNotFoundError,
} from "../dist/application/get-settlement-audit.js";
import { createDatabasePool } from "../dist/database/pool.js";
import { PostgresOzavOfframpIntentRepository } from "../dist/repositories/postgres-ozav-offramp-intent-repository.js";
import { PostgresOzavOnrampIntentRepository } from "../dist/repositories/postgres-ozav-onramp-intent-repository.js";
import { PostgresOzavOnrampRepository } from "../dist/repositories/postgres-ozav-onramp-repository.js";
import { PostgresSettlementRepository } from "../dist/repositories/postgres-settlement-repository.js";
import { PostgresSolanaContingencyReserveRepository } from "../dist/repositories/solana-contingency-reserve-repository.js";
import { PostgresSolanaSettlementConfirmationRepository } from "../dist/repositories/solana-settlement-confirmation-repository.js";

const settlementId = process.argv[2];

if (
  !settlementId
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(settlementId)
) {
  throw new Error(
    "Usage: npm run demo:audit -- <settlement_id>",
  );
}

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is required for the audit demo");
}

const pool = createDatabasePool(
  connectionString,
  process.env.DATABASE_SSL === "true",
);

const settlements = new PostgresSettlementRepository(pool);
const onrampIntents =
  new PostgresOzavOnrampIntentRepository(pool);
const onramps = new PostgresOzavOnrampRepository(pool);
const contingencyReserves =
  new PostgresSolanaContingencyReserveRepository(pool);
const solanaSettlements =
  new PostgresSolanaSettlementConfirmationRepository(pool);
const offramps =
  new PostgresOzavOfframpIntentRepository(pool);

const reader = new GetSettlementAuditService({
  settlements,
  onrampIntents,
  onramps,
  contingencyReserves,
  solanaSettlements,
  offramps,
});

function explorer(signature) {
  const rpc = (process.env.SOLANA_RPC_URL ?? "")
    .toLowerCase();
  const cluster = rpc.includes("devnet")
    ? "devnet"
    : rpc.includes("testnet")
      ? "testnet"
      : null;

  return cluster
    ? `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`
    : `https://explorer.solana.com/tx/${signature}`;
}

function status(value) {
  return value ?? "ausente";
}

function printSignature(label, signature) {
  if (signature) {
    console.log(`${label}: ${explorer(signature)}`);
  }
}

try {
  const audit = await reader.execute(settlementId);

  console.log(
    `\nAUDITORIA CONSOLIDADA: ${
      audit.checks.evidenceComplete ? "OK" : "INCOMPLETA"
    }`,
  );
  console.table([{
    settlement_id: audit.settlement.id,
    settlement_status: audit.settlement.status,
    onramp_status: status(audit.onramp?.providerStatus),
    reserve_status: status(
      audit.contingencyReserve?.status,
    ),
    solana_verificada:
      audit.solanaSettlement?.verified ?? false,
    offramp_status: status(audit.offramp?.providerStatus),
    evidencia_completa: audit.checks.evidenceComplete,
  }]);

  console.table([
    {
      verificacao: "on-ramp concluído",
      ok: audit.checks.onrampCompleted,
    },
    {
      verificacao: "reserva resolvida",
      ok: audit.checks.reserveResolved,
    },
    {
      verificacao: "transação Solana registrada",
      ok: audit.checks.solanaTransactionRecorded,
    },
    {
      verificacao: "off-ramp concluído",
      ok: audit.checks.offrampCompleted,
    },
    {
      verificacao: "liquidação paga",
      ok: audit.checks.settlementPaidOut,
    },
  ]);

  const events = [
    ...(audit.onramp?.events ?? []).map((event) => ({
      etapa: "on-ramp",
      event_id: event.eventId,
      event_type: event.eventType,
      provider_status: event.providerStatus,
      occurred_at: event.occurredAt,
      content_hash: event.contentHash,
    })),
    ...(audit.offramp?.events ?? []).map((event) => ({
      etapa: "off-ramp",
      event_id: event.eventId,
      event_type: event.eventType,
      provider_status: event.providerStatus,
      occurred_at: event.occurredAt,
      content_hash: event.contentHash,
    })),
  ];

  if (events.length) {
    console.log("\nEVENTOS OZAV PERSISTIDOS");
    console.table(events);
  }

  printSignature(
    "RESERVA",
    audit.contingencyReserve?.createSignature,
  );
  printSignature(
    audit.contingencyReserve?.resolutionAction === "settled"
      ? "RESOLUÇÃO DA RESERVA"
      : "REFUND DA RESERVA",
    audit.contingencyReserve?.resolutionSignature,
  );
  printSignature(
    "LIQUIDAÇÃO ATÔMICA",
    audit.solanaSettlement?.atomicSignature,
  );

  if (audit.warnings.length) {
    console.log("\nALERTAS");
    for (const warning of audit.warnings) {
      console.log(`- ${warning}`);
    }
  }

  console.log(
    "Relatório sanitizado: QR, código Pix, credenciais e chaves de idempotência não são exibidos.",
  );
} catch (error) {
  if (error instanceof SettlementAuditNotFoundError) {
    throw new Error(`Settlement não encontrado: ${settlementId}`);
  }

  throw error;
} finally {
  await pool.end();
}
