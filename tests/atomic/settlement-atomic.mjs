// Peragus: dois testes de integracao em um validator LOCAL ja iniciado.
// Coloque este arquivo em tests/atomic/settlement-atomic.mjs.
// Demo assets only. No real fiat value or redemption.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, createMint, createAccount, mintTo, unpackAccount,
} from '@solana/spl-token';

// Endpoint fixo: este teste nao aceita RPC externo ou wallet de arquivo.
const RPC = 'http://127.0.0.1:18899';
const PROGRAM = new PublicKey('6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w');
const OPTIONS = { commitment: 'confirmed', preflightCommitment: 'confirmed' };
const connection = new Connection(RPC, OPTIONS.commitment);
const idl = JSON.parse(readFileSync(new URL('../../target/idl/peragus.json', import.meta.url), 'utf8'));
assert.equal(idl.address, PROGRAM.toBase58(), 'Program ID inesperado na IDL');

// Apenas os tipos usados por create_settlement. A ordem vem da IDL.
function encode(type, value) {
  if (type === 'u64') {
    assert.equal(typeof value, 'bigint', 'Quantidades devem ser bigint');
    assert(value >= 0n && value <= 0xffffffffffffffffn, 'u64 fora do intervalo');
    const data = Buffer.alloc(8);
    data.writeBigUInt64LE(value);
    return data;
  }
  if (type === 'pubkey') return new PublicKey(value).toBuffer();
  if (type?.array?.[0] === 'u8') {
    const data = Buffer.from(value);
    assert.equal(data.length, type.array[1], 'Tamanho de array incorreto');
    return data;
  }
  throw new Error(`Tipo de argumento nao suportado: ${JSON.stringify(type)}`);
}

function instruction(name, accounts, args = {}) {
  const definition = idl.instructions.find(item => item.name === name);
  assert(definition, `Instrucao ausente na IDL: ${name}`);
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: definition.accounts.map(account => {
      const key = accounts[account.name] ?? account.address;
      assert(key, `Conta ausente: ${account.name}`);
      return {
        pubkey: new PublicKey(key),
        isSigner: account.signer === true,
        isWritable: account.writable === true,
      };
    }),
    data: Buffer.concat([
      Buffer.from(definition.discriminator),
      ...definition.args.map(arg => encode(arg.type, args[arg.name])),
    ]),
  });
}

// Leitura Borsh orientada pela IDL; sem offsets fixos para o status.
function decodeSettlement(info) {
  assert(info, 'Settlement nao encontrada');
  assert(info.owner.equals(PROGRAM), 'Owner da Settlement incorreto');
  const account = idl.accounts.find(item => item.name === 'Settlement');
  assert(account, 'Discriminador de Settlement ausente');
  const discriminator = Buffer.from(account.discriminator);
  assert.deepEqual(info.data.subarray(0, discriminator.length), discriminator);
  let offset = discriminator.length;
  function take(length) {
    assert(offset + length <= info.data.length, 'Settlement truncada');
    const value = info.data.subarray(offset, offset + length);
    offset += length;
    return value;
  }
  function decode(type) {
    if (type === 'u8') return take(1)[0];
    if (type === 'u64') return take(8).readBigUInt64LE();
    if (type === 'i64') return take(8).readBigInt64LE();
    if (type === 'pubkey') return new PublicKey(take(32)).toBase58();
    if (type?.array?.[0] === 'u8') return Buffer.from(take(type.array[1]));
    if (type?.defined) {
      const name = typeof type.defined === 'string' ? type.defined : type.defined.name;
      const definition = idl.types.find(item => item.name === name)?.type;
      assert.equal(definition?.kind, 'enum', `Tipo definido inesperado: ${name}`);
      const variant = definition.variants[take(1)[0]];
      assert(variant && !variant.fields?.length, 'Variante de enum invalida');
      return variant.name;
    }
    throw new Error(`Tipo de estado nao suportado: ${JSON.stringify(type)}`);
  }
  const definition = idl.types.find(item => item.name === 'Settlement')?.type;
  assert.equal(definition?.kind, 'struct');
  const result = Object.fromEntries(definition.fields.map(field => [field.name, decode(field.type)]));
  assert.equal(offset, info.data.length, 'Layout da Settlement diverge da IDL');
  return result;
}

// Airdrop nao fornece lastValidBlockHeight: confirmamos pela propria signature.
async function waitForAirdrop(signature) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const { value: [status] } = await connection.getSignatureStatuses([signature]);
    if (status) {
      assert.equal(status.err, null, 'Airdrop falhou');
      if (['confirmed', 'finalized'].includes(status.confirmationStatus)) return;
    }
    await delay(250);
  }
  throw new Error('Airdrop local nao confirmou em 30 segundos');
}

async function transactionDetails(signature) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await connection.getTransaction(signature, {
      commitment: 'confirmed', maxSupportedTransactionVersion: 0,
    });
    if (result?.meta) return result;
    await delay(250);
  }
  throw new Error(`Metadados indisponiveis para ${signature}`);
}

async function send(ix, payer, extraSigners = [], expectedFailure = false) {
  const lifetime = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: payer.publicKey, ...lifetime }).add(ix);
  tx.sign(payer, ...extraSigners);
  // Somente o caso de rollback pula preflight para registrar a falha na rede LOCAL.
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: expectedFailure,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });
  console.log(`  tx: ${signature}`);
  const confirmation = await connection.confirmTransaction({ signature, ...lifetime }, 'confirmed');
  const result = await transactionDetails(signature);
  assert.deepEqual(result.meta.err, confirmation.value.err, 'Confirmacao e metadados divergentes');
  if (expectedFailure) {
    assert.notEqual(result.meta.err, null, 'A transacao deveria ter falhado');
  } else {
    assert.equal(result.meta.err, null, `Transacao falhou: ${JSON.stringify(result.meta.err)}`);
  }
  return { signature, ...result };
}

const accountNames = ['payer_pgbrl', 'liquidity_pgbrl', 'liquidity_pypyg', 'recipient_pypyg'];
async function snapshot(accounts, settlement, minContextSlot = 0) {
  const addresses = [...accountNames.map(name => accounts[name]), settlement];
  const infos = await connection.getMultipleAccountsInfo(addresses, {
    commitment: 'confirmed', minContextSlot,
  });
  const balances = infos.slice(0, 4).map((info, index) =>
    unpackAccount(addresses[index], info, TOKEN_2022_PROGRAM_ID).amount);
  const state = decodeSettlement(infos[4]);
  return { balances, state, raw: infos.map(info => Buffer.from(info.data)) };
}

function showBalances(before, after) {
  console.table(accountNames.map((account, index) => ({
    account, before: before.balances[index].toString(), after: after.balances[index].toString(),
  })));
  console.log(`  status: ${before.state.status} -> ${after.state.status}`);
}

async function main() {
  console.log('Peragus | Demo assets only. No real fiat value or redemption.');
  console.log(`RPC: ${RPC}`);
  console.log('Valores nas tabelas em unidades inteiras dos tokens.');
  for (const address of [PROGRAM, TOKEN_2022_PROGRAM_ID]) {
    const info = await connection.getAccountInfo(address);
    assert(info?.executable, `Programa indisponivel: ${address.toBase58()}`);
  }

  // Todas as chaves ficam em memoria; nenhum id.json e acessado ou criado.
  const payer = Keypair.generate();
  const liquidity = Keypair.generate();
  const recipient = Keypair.generate();
  await waitForAirdrop(await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL));

  console.log('Criando dois mints Token-2022 sem extensoes e quatro token accounts...');
  const pgbrl = await createMint(connection, payer, payer.publicKey, null, 6,
    Keypair.generate(), OPTIONS, TOKEN_2022_PROGRAM_ID);
  const pypyg = await createMint(connection, payer, payer.publicKey, null, 0,
    Keypair.generate(), OPTIONS, TOKEN_2022_PROGRAM_ID);
  const accounts = {
    payer: payer.publicKey,
    liquidity_authority: liquidity.publicKey,
    source_mint: pgbrl,
    destination_mint: pypyg,
    token_program: TOKEN_2022_PROGRAM_ID,
  };
  for (const [name, mint, authority] of [
    ['payer_pgbrl', pgbrl, payer.publicKey],
    ['liquidity_pgbrl', pgbrl, liquidity.publicKey],
    ['liquidity_pypyg', pypyg, liquidity.publicKey],
    ['recipient_pypyg', pypyg, recipient.publicKey],
  ]) {
    accounts[name] = await createAccount(connection, payer, mint, authority,
      Keypair.generate(), OPTIONS, TOKEN_2022_PROGRAM_ID);
  }

  const amountIn = 25_000_000n; // 25 pgBRL, com 6 decimais.
  const amountOut = 37_500n;   // 37.500 pyPYG, com 0 decimais. Cotacao ficticia.
  await mintTo(connection, payer, pgbrl, accounts.payer_pgbrl, payer,
    100_000_000n, [], OPTIONS, TOKEN_2022_PROGRAM_ID);
  // Liquidez suficiente para exatamente UMA operacao.
  await mintTo(connection, payer, pypyg, accounts.liquidity_pypyg, payer,
    amountOut, [], OPTIONS, TOKEN_2022_PROGRAM_ID);

  async function createSettlement() {
    const id = randomBytes(32);
    const [address, bump] = PublicKey.findProgramAddressSync([Buffer.from('settlement'), id], PROGRAM);
    // Criacao confirmada separadamente: rollback da execucao deve preservar Pending.
    const creation = await send(instruction('create_settlement', {
      payer: payer.publicKey, settlement: address, system_program: SystemProgram.programId,
    }, {
      settlement_id: id, amount_in: amountIn, amount_out: amountOut,
      source_mint: pgbrl, destination_mint: pypyg,
      recipient: recipient.publicKey, liquidity_authority: liquidity.publicKey,
    }), payer);
    const before = await snapshot(accounts, address, creation.slot);
    assert.deepEqual(before.state.settlement_id, id);
    for (const [field, value] of Object.entries({
      payer: payer.publicKey, source_mint: pgbrl, destination_mint: pypyg,
      recipient: recipient.publicKey, liquidity_authority: liquidity.publicKey,
    })) assert.equal(before.state[field], value.toBase58());
    assert.equal(before.state.amount_in, amountIn);
    assert.equal(before.state.amount_out, amountOut);
    assert.equal(before.state.bump, bump);
    assert.equal(before.state.status, 'Pending');
    return { address, before };
  }

  console.log('\nTESTE 1: happy path');
  const happy = await createSettlement();
  assert.deepEqual(happy.before.balances, [100_000_000n, 0n, amountOut, 0n]);
  const completed = await send(instruction('execute_settlement', {
    ...accounts, settlement: happy.address,
  }), payer, [liquidity]);
  const settled = await snapshot(accounts, happy.address, completed.slot);
  assert.deepEqual(settled.balances, [75_000_000n, amountIn, 0n, amountOut]);
  assert.deepEqual(settled.state, { ...happy.before.state, status: 'Settled' });
  const happyLogs = completed.meta.logMessages ?? [];
  assert(happyLogs.includes('Program log: Leg A CPI succeeded'));
  assert(happyLogs.includes('Program log: Leg B CPI succeeded'));
  showBalances(happy.before, settled);
  console.log('PASS: duas pernas e status Settled confirmados.');

  console.log('\nTESTE 2: rollback por falta de pyPYG na segunda perna');
  const rollback = await createSettlement();
  assert(rollback.before.balances[0] >= amountIn, 'Leg A precisa ter saldo suficiente');
  assert.equal(rollback.before.balances[2], 0n, 'Leg B deve estar sem liquidez');
  const failed = await send(instruction('execute_settlement', {
    ...accounts, settlement: rollback.address,
  }), payer, [liquidity], true);
  const logs = failed.meta.logMessages ?? [];
  console.log(logs.join('\n'));
  // SPL Token: Custom(1) = InsufficientFunds. Nao aceitar qualquer erro como sucesso.
  assert.deepEqual(failed.meta.err, { InstructionError: [0, { Custom: 1 }] });
  const legAIndex = logs.indexOf('Program log: Leg A CPI succeeded');
  assert(legAIndex >= 0, 'Leg A nao chegou a completar a CPI');
  const legBLogs = logs.slice(legAIndex + 1);
  assert(legBLogs.some(line => line.startsWith(`Program ${TOKEN_2022_PROGRAM_ID} invoke [`)),
    'A segunda CPI Token-2022 nao foi chamada');
  assert(legBLogs.some(line => line.startsWith(`Program ${TOKEN_2022_PROGRAM_ID} failed:`)),
    'Falta evidencia de falha na segunda CPI Token-2022');
  assert(!logs.includes('Program log: Leg B CPI succeeded'));
  const reverted = await snapshot(accounts, rollback.address, failed.slot);
  assert.deepEqual(reverted.balances, rollback.before.balances, 'Saldos nao reverteram');
  assert.deepEqual(reverted.raw, rollback.before.raw, 'Dados de alguma conta nao reverteram');
  assert.equal(reverted.state.status, 'Pending');
  showBalances(rollback.before, reverted);
  console.log('PASS: Leg A executou, Leg B falhou, quatro contas e Settlement preservadas.');
  console.log('\n2/2 testes passaram. Happy path e rollback verificados no validator local.');
}

main().catch(error => {
  console.error('\nFAIL:', error.message);
  if (error.logs) console.error(error.logs.join('\n'));
  if (error.actual !== undefined) console.error('Actual:', error.actual);
  if (error.expected !== undefined) console.error('Expected:', error.expected);
  process.exitCode = 1;
});
