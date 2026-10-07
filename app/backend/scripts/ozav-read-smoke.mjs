import "dotenv/config";
import { OzavClient } from "../dist/providers/ozav-client.js";

try {
  const { OZAV_API_KEY: apiKey, OZAV_TRANSFER_ID: transferId,
    OZAV_CUSTOMER_ID: customerId, OZAV_WALLET_ID: walletId } = process.env;
  if (!apiKey || !transferId || !customerId || !walletId) {
    throw new Error("Configure OZAV_API_KEY, OZAV_TRANSFER_ID, OZAV_CUSTOMER_ID e OZAV_WALLET_ID no .env");
  }
  const client = new OzavClient({ apiKey });
  const capabilities = await client.getCapabilities();
  for (const scope of ["transfers:read", "events:read"]) {
    if (!capabilities.scopes.includes(scope)) {
      throw new Error(`Falta o scope ${scope}`);
    }
  }

  console.log("Ambiente confirmado: test");
  const transfer = await client.getTransfer(transferId);
  if (transfer.customerId !== customerId
    || transfer.destination.walletId !== walletId
    || transfer.source.type !== "fiat_payment"
    || transfer.source.rail !== "pix"
    || transfer.destination.type !== "wallet"
    || transfer.amounts.source.currency !== "BRL"
    || transfer.amounts.target.currency !== "USDT") {
    throw new Error("A transferencia nao corresponde ao on-ramp BRL/Pix para a carteira configurada");
  }

  const events = new Map();
  const cursors = new Set();
  let cursor;
  let finished = false;
  for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
    console.log(`Consultando eventos: pagina ${pageNumber}/10`);
    const page = await client.listEvents(cursor);
    for (const event of page.data) {
      if (event.transfer?.id === transferId) events.set(event.id, event);
    }
    if (!page.hasMore) {
      finished = true;
      break;
    }
    if (cursors.has(page.nextCursor)) {
      throw new Error("A OZAV repetiu um cursor de paginacao");
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  if (!finished) throw new Error("Limite de 10 paginas atingido; a consulta de eventos ficou incompleta");
  if (!events.size) throw new Error("Nenhum evento encontrado para a transferencia configurada");

  const orderedEvents = [...events.values()].sort((a, b) =>
    Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  console.log("CLIENTE OZAV — LEITURA SANDBOX: OK");
  console.table([{
    transfer_id: transfer.id, status_atual: transfer.status,
    source_leg: transfer.sourceLegStatus,
    destination_leg: transfer.destinationLegStatus,
    BRL: transfer.amounts.source.amount, USDT: transfer.amounts.target.amount,
  }]);
  console.table(orderedEvents.map((event) => ({
    event_id: event.id, type: event.type, created_at: event.createdAt,
    status_no_evento: event.transfer?.status,
  })));
  console.log("Nenhuma transferencia criada ou simulada; nenhum settlement Peragus alterado.");
} catch (error) {
  console.error("FALHA:", error instanceof Error ? error.message : "Erro inesperado");
  process.exitCode = 1;
}
