// Peragus: corredores, settlement e controle administrativo em validator LOCAL.
// Coloque este arquivo em tests/atomic/settlement-atomic.mjs.
// Demo assets only. No real fiat value or redemption.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID, createMint, createAccount, mintTo, unpackAccount,
} from '@solana/spl-token';

// Endpoint fixo. A unica chave lida de arquivo e o admin LOCAL de teste.
const RPC = 'http://127.0.0.1:18899';
const PROGRAM = new PublicKey('6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w');
const OPTIONS = { commitment: 'confirmed', preflightCommitment: 'confirmed' };
const connection = new Connection(RPC, OPTIONS.commitment);
const idl = JSON.parse(readFileSync(new URL('../../target/idl/peragus.json', import.meta.url), 'utf8'));
assert.equal(idl.address, PROGRAM.toBase58(), 'Program ID inesperado na IDL');

// A ordem dos argumentos vem da IDL.
function encode(type, value) {
  if (type === 'bool') {
    assert.equal(typeof value, 'boolean', 'Esperado boolean');
    return Buffer.from([value ? 1 : 0]);
  }
  if (type === 'u64') {
    assert.equal(typeof value, 'bigint', 'Quantidades devem ser bigint');
    assert(value >= 0n && value <= 0xffffffffffffffffn, 'u64 fora do intervalo');
    const data = Buffer.alloc(8);
    data.writeBigUInt64LE(value);
    return data;
  }
  if (type === 'i64') {
    assert.equal(typeof value, 'bigint', 'Timestamps devem ser bigint');
    assert(
      value >= -0x8000000000000000n &&
        value <= 0x7fffffffffffffffn,
      'i64 fora do intervalo'
    );
    const data = Buffer.alloc(8);
    data.writeBigInt64LE(value);
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
function decodeAccount(info, accountName) {
  assert(info, `${accountName} nao encontrada`);
  assert(info.owner.equals(PROGRAM), `Owner de ${accountName} incorreto`);
  const account = idl.accounts.find(item => item.name === accountName);
  assert(account, `Discriminador de ${accountName} ausente`);
  const discriminator = Buffer.from(account.discriminator);
  assert.deepEqual(info.data.subarray(0, discriminator.length), discriminator);
  let offset = discriminator.length;

  function take(length) {
    assert(offset + length <= info.data.length, `${accountName} truncada`);
    const value = info.data.subarray(offset, offset + length);
    offset += length;
    return value;
  }

  function decode(type) {
    if (type === 'bool') {
      const value = take(1)[0];
      assert(value === 0 || value === 1, 'Boolean Borsh invalido');
      return value === 1;
    }
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

  const definition = idl.types.find(item => item.name === accountName)?.type;
  assert.equal(definition?.kind, 'struct');
  const result = Object.fromEntries(
    definition.fields.map(field => [field.name, decode(field.type)])
  );
  assert.equal(offset, info.data.length, `Layout de ${accountName} diverge da IDL`);
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
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (result?.meta) return result;
    await delay(250);
  }
  throw new Error(`Metadados indisponiveis para ${signature}`);
}

const submittedSignatures = new Set();

async function send(ix, payer, extraSigners = [], expectedFailure = false) {
  let lifetime;
  let tx;
  let signatureBytes;

  // Mesma instrucao e mesmos signers precisam de uma NOVA transacao.
  // Se o blockhash ainda for igual, aguardar evita testar apenas o cache da rede.
  for (let attempt = 0; attempt < 120; attempt++) {
    lifetime = await connection.getLatestBlockhash('confirmed');
    tx = new Transaction({ feePayer: payer.publicKey, ...lifetime }).add(ix);
    tx.sign(payer, ...extraSigners);
    signatureBytes = tx.signature.toString('hex');
    if (!submittedSignatures.has(signatureBytes)) break;
    await delay(250);
  }

  assert(
    !submittedSignatures.has(signatureBytes),
    'Nao foi possivel obter uma transacao nova'
  );
  submittedSignatures.add(signatureBytes);

  // As rejeicoes esperadas pulam preflight para registrar a falha na rede LOCAL.
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: expectedFailure,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  console.log(`  tx: ${signature}`);

  const confirmation = await connection.confirmTransaction(
    { signature, ...lifetime },
    'confirmed'
  );
  const result = await transactionDetails(signature);

  assert.deepEqual(
    result.meta.err,
    confirmation.value.err,
    'Confirmacao e metadados divergentes'
  );

  if (expectedFailure) {
    assert.notEqual(result.meta.err, null, 'A transacao deveria ter falhado');
  } else {
    assert.equal(
      result.meta.err,
      null,
      `Transacao falhou: ${JSON.stringify(result.meta.err)}`
    );
  }

  return { signature, ...result };
}

const accountNames = [
  'payer_pgbrl',
  'liquidity_pgbrl',
  'liquidity_pypyg',
  'recipient_pypyg',
];

async function snapshot(accounts, settlement, minContextSlot = 0) {
  const addresses = [
    ...accountNames.map(name => accounts[name]),
    settlement,
  ];

  const infos = await connection.getMultipleAccountsInfo(addresses, {
    commitment: 'confirmed',
    minContextSlot,
  });

  const balances = infos.slice(0, 4).map((info, index) =>
    unpackAccount(
      addresses[index],
      info,
      TOKEN_2022_PROGRAM_ID
    ).amount
  );

  const state = decodeAccount(infos[4], 'Settlement');

  return {
    balances,
    state,
    raw: infos.map(info => Buffer.from(info.data)),
  };
}

function showBalances(before, after) {
  console.table(accountNames.map((account, index) => ({
    account,
    before: before.balances[index].toString(),
    after: after.balances[index].toString(),
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

  // Payer, provedor e destinatario sao novos a cada execucao.
  const payer = Keypair.generate();
  const liquidity = Keypair.generate();
  const recipient = Keypair.generate();
  const attestor = Keypair.generate();

  await waitForAirdrop(
    await connection.requestAirdrop(
      payer.publicKey,
      2 * LAMPORTS_PER_SOL
    )
  );

  const adminFile = join(
    homedir(),
    '.local',
    'share',
    'peragus-local-tests',
    'admin-keypair.json'
  );

  const admin = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(readFileSync(adminFile, 'utf8'))
    )
  );

  console.log(`Admin local de teste: ${admin.publicKey.toBase58()}`);

  const [config, configBump] = PublicKey.findProgramAddressSync(
    [Buffer.from('config')],
    PROGRAM
  );

  const loader = new PublicKey(
    'BPFLoaderUpgradeab1e11111111111111111111111'
  );

  const [programData] = PublicKey.findProgramAddressSync(
    [PROGRAM.toBuffer()],
    loader
  );

  const initAccounts = {
    admin: admin.publicKey,
    peragus_program: PROGRAM,
    program_data: programData,
    config,
    system_program: SystemProgram.programId,
  };

  let passed = 0;

  async function configSnapshot(minContextSlot = 0) {
    const info = await connection.getAccountInfo(config, {
      commitment: 'confirmed',
      minContextSlot,
    });

    return {
      state: decodeAccount(info, 'Config'),
      raw: Buffer.from(info.data),
    };
  }

  function checkConfig(state, paused) {
    assert.deepEqual(state, {
      admin: admin.publicKey.toBase58(),
      attestation_authority: attestor.publicKey.toBase58(),
      paused,
      bump: configBump,
    });
  }

  function assertNoTokenCpi(logs) {
    assert(
      !logs.some(line =>
        line.startsWith(`Program ${TOKEN_2022_PROGRAM_ID} invoke [`)
      ),
      'Nao deveria haver CPI Token-2022'
    );
  }

  function anchorError(name, accountName) {
    const definition = idl.errors.find(item => item.name === name);
    assert(definition, `Erro ausente na IDL: ${name}`);

    return (error, rejectionLogs) => {
      assert.deepEqual(error, {
        InstructionError: [0, { Custom: definition.code }],
      });

      assert(
        rejectionLogs.some(line =>
          line.includes(`Error Code: ${name}.`)
        ),
        `O log nao identifica ${name}`
      );

      if (accountName) {
        assert(
          rejectionLogs.some(line =>
            line.includes(`caused by account: ${accountName}.`)
          ),
          `A rejeicao nao veio da verificacao de ${accountName}`
        );
      }
    };
  }

  function eventWasEmitted(logs, name) {
    const normalize = value =>
      value.replaceAll('_', '').toLowerCase();

    const definition = (idl.events ?? []).find(event =>
      normalize(event.name) === normalize(name)
    );

    assert(definition, `Evento ausente na IDL: ${name}`);

    const discriminator = Buffer.from(definition.discriminator);

    return logs.some(line => {
      const prefix = 'Program data: ';
      if (!line.startsWith(prefix)) return false;

      const data = Buffer.from(
        line.slice(prefix.length),
        'base64'
      );

      return data.length >= discriminator.length &&
        data
          .subarray(0, discriminator.length)
          .equals(discriminator);
    });
  }

  function assertEvent(logs, name) {
    assert(
      eventWasEmitted(logs, name),
      `Evento ausente: ${name}`
    );
  }

  function assertNoEvent(logs, name) {
    assert(
      !eventWasEmitted(logs, name),
      `Evento indevido: ${name}`
    );
  }

  const existingConfig = await connection.getAccountInfo(
    config,
    'confirmed'
  );

  if (!existingConfig) {
    console.log('\nCONFIG A: intruso nao pode inicializar a Config');

    const rejected = await send(
      instruction('initialize_config', {
        ...initAccounts,
        admin: payer.publicKey,
      }, {
        attestation_authority: attestor.publicKey,
      }),
      payer,
      [],
      true
    );

    const logs = rejected.meta.logMessages ?? [];
    console.log(logs.join('\n'));

    anchorError('Unauthorized', 'program_data')(
      rejected.meta.err,
      logs
    );

    assertNoTokenCpi(logs);

    assert.equal(
      await connection.getAccountInfo(config, {
        commitment: 'confirmed',
        minContextSlot: rejected.slot,
      }),
      null,
      'Intruso criou a Config'
    );

    console.log(
      'PASS: inicializacao nao autorizada rejeitada; Config continua ausente.'
    );
    passed++;

    console.log('\nCONFIG B: upgrade authority inicializa a Config');

    await waitForAirdrop(
      await connection.requestAirdrop(
        admin.publicKey,
        LAMPORTS_PER_SOL
      )
    );

    const initialized = await send(
      instruction('initialize_config', initAccounts, {
        attestation_authority: attestor.publicKey,
      }),
      payer,
      [admin]
    );

    checkConfig(
      (await configSnapshot(initialized.slot)).state,
      false
    );

    console.log('PASS: admin correto, paused=false e bump correto.');
    passed++;
  } else {
    checkConfig(decodeAccount(existingConfig, 'Config'), false);
    console.log('\nConfig existente validada. CONFIG A e B nao foram repetidos.');
    console.log('Para testar novamente a primeira inicializacao, use um ledger novo.');
  }

  console.log('\nCONFIG C: nem o admin pode reinicializar a Config');

  const configBeforeReinit = await configSnapshot();

  const reinit = await send(
    instruction('initialize_config', initAccounts, {
      attestation_authority: attestor.publicKey,
    }),
    payer,
    [admin],
    true
  );

  const reinitLogs = reinit.meta.logMessages ?? [];
  console.log(reinitLogs.join('\n'));

  assert.deepEqual(reinit.meta.err, {
    InstructionError: [0, { Custom: 0 }],
  });

  assert(
    reinitLogs.some(line =>
      /already in use/i.test(line) &&
      line.includes(config.toBase58())
    ),
    'Reinicializacao deve falhar porque a PDA ja existe'
  );

  assert(
    reinitLogs.some(line =>
      line.startsWith(`Program ${SystemProgram.programId} failed:`)
    )
  );

  assert.deepEqual(
    (await configSnapshot(reinit.slot)).raw,
    configBeforeReinit.raw
  );

  assertNoTokenCpi(reinitLogs);
  console.log('PASS: reinicializacao rejeitada; Config preservada.');
  passed++;

  console.log(
    'Criando tres mints Token-2022 sem extensoes e quatro token accounts...'
  );

  const pgbrl = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    6,
    Keypair.generate(),
    OPTIONS,
    TOKEN_2022_PROGRAM_ID
  );

  const pypyg = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    0,
    Keypair.generate(),
    OPTIONS,
    TOKEN_2022_PROGRAM_ID
  );

  const otherMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    6,
    Keypair.generate(),
    OPTIONS,
    TOKEN_2022_PROGRAM_ID
  );

  const corridorId = randomBytes(32);
  const [corridor, corridorBump] = PublicKey.findProgramAddressSync(
    [Buffer.from('corridor'), corridorId],
    PROGRAM
  );

  const alternateCorridorId = randomBytes(32);
  const [alternateCorridor] = PublicKey.findProgramAddressSync(
    [Buffer.from('corridor'), alternateCorridorId],
    PROGRAM
  );

  const accounts = {
    config,
    corridor,
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
    accounts[name] = await createAccount(
      connection,
      payer,
      mint,
      authority,
      Keypair.generate(),
      OPTIONS,
      TOKEN_2022_PROGRAM_ID
    );
  }

  const corridorAccounts = {
    admin: admin.publicKey,
    config,
    source_mint: pgbrl,
    destination_mint: pypyg,
    corridor,
    system_program: SystemProgram.programId,
  };

  console.log('\nCORRIDOR A: nao-admin nao pode cadastrar corredor');

  const rejectedCorridor = await send(
    instruction('create_corridor', {
      ...corridorAccounts,
      admin: payer.publicKey,
    }, {
      corridor_id: corridorId,
      liquidity_authority: liquidity.publicKey,
    }),
    payer,
    [],
    true
  );

  const rejectedCorridorLogs = rejectedCorridor.meta.logMessages ?? [];
  console.log(rejectedCorridorLogs.join('\n'));

  anchorError('Unauthorized', 'config')(
    rejectedCorridor.meta.err,
    rejectedCorridorLogs
  );

  assertNoTokenCpi(rejectedCorridorLogs);
  assertNoEvent(rejectedCorridorLogs, 'CorridorCreated');

  assert.equal(
    await connection.getAccountInfo(corridor, {
      commitment: 'confirmed',
      minContextSlot: rejectedCorridor.slot,
    }),
    null,
    'Nao-admin criou o corredor'
  );

  console.log('PASS: cadastro nao autorizado rejeitado; Corridor ausente.');
  passed++;

  console.log('\nCORRIDOR B: admin cadastra corredor');

  const createdCorridor = await send(
    instruction('create_corridor', corridorAccounts, {
      corridor_id: corridorId,
      liquidity_authority: liquidity.publicKey,
    }),
    payer,
    [admin]
  );

  const corridorInfo = await connection.getAccountInfo(corridor, {
    commitment: 'confirmed',
    minContextSlot: createdCorridor.slot,
  });

  assertEvent(
    createdCorridor.meta.logMessages ?? [],
    'CorridorCreated'
  );

  assert.deepEqual(decodeAccount(corridorInfo, 'Corridor'), {
    corridor_id: corridorId,
    source_mint: pgbrl.toBase58(),
    destination_mint: pypyg.toBase58(),
    liquidity_authority: liquidity.publicKey.toBase58(),
    bump: corridorBump,
  });

  console.log('PASS: Corridor PDA, mints, provedor e bump confirmados.');
  passed++;

  // Segundo corredor valido, usado somente para provar que uma Settlement
  // nao aceita a troca de sua Corridor PDA durante a execucao.
  await send(
    instruction('create_corridor', {
      ...corridorAccounts,
      corridor: alternateCorridor,
    }, {
      corridor_id: alternateCorridorId,
      liquidity_authority: liquidity.publicKey,
    }),
    payer,
    [admin]
  );

  const amountIn = 25_000_000n;
  const amountOut = 37_500n;
  const futureExpiry = BigInt(
    Math.floor(Date.now() / 1000) + 3600
  );

  await mintTo(
    connection,
    payer,
    pgbrl,
    accounts.payer_pgbrl,
    payer,
    100_000_000n,
    [],
    OPTIONS,
    TOKEN_2022_PROGRAM_ID
  );

  // Liquidez suficiente para exatamente UMA operacao.
  await mintTo(
    connection,
    payer,
    pypyg,
    accounts.liquidity_pypyg,
    payer,
    amountOut,
    [],
    OPTIONS,
    TOKEN_2022_PROGRAM_ID
  );

  async function expectSettlementCreationRejected(
    label,
    overrides,
    errorName,
    attestationAuthority = attestor.publicKey,
    signers = [attestor],
    accountName
  ) {
    console.log(`\n${label}`);

    const id = randomBytes(32);
    const [address] = PublicKey.findProgramAddressSync(
      [Buffer.from('settlement'), id],
      PROGRAM
    );

    const result = await send(
      instruction('create_settlement', {
        config,
        attestation_authority: attestationAuthority,
        corridor,
        payer: payer.publicKey,
        settlement: address,
        system_program: SystemProgram.programId,
      }, {
        settlement_id: id,
        amount_in: amountIn,
        amount_out: amountOut,
        expires_at: futureExpiry,
        source_mint: pgbrl,
        destination_mint: pypyg,
        recipient: recipient.publicKey,
        liquidity_authority: liquidity.publicKey,
        ...overrides,
      }),
      payer,
      signers,
      true
    );

    const logs = result.meta.logMessages ?? [];
    console.log(logs.join('\n'));

    anchorError(errorName, accountName)(result.meta.err, logs);
    assertNoTokenCpi(logs);
    assertNoEvent(logs, 'SettlementCreated');

    assert.equal(
      await connection.getAccountInfo(address, {
        commitment: 'confirmed',
        minContextSlot: result.slot,
      }),
      null,
      'Settlement divergente foi criada'
    );

    console.log('PASS: parametros divergentes rejeitados; Settlement ausente.');
    passed++;
  }

  await expectSettlementCreationRejected(
    'CORRIDOR C: source_mint divergente e rejeitado',
    { source_mint: otherMint },
    'InvalidMint'
  );

  await expectSettlementCreationRejected(
    'CORRIDOR D: destination_mint divergente e rejeitado',
    { destination_mint: otherMint },
    'InvalidMint'
  );

  await expectSettlementCreationRejected(
    'CORRIDOR E: provedor divergente e rejeitado',
    { liquidity_authority: payer.publicKey },
    'InvalidLiquidityAuthority'
  );

  await expectSettlementCreationRejected(
    'ATTESTATION A: autoridade nao configurada e rejeitada',
    {},
    'InvalidAttestationAuthority',
    payer.publicKey,
    [],
    'config'
  );

  await expectSettlementCreationRejected(
    'ATTESTATION B: autorizacao ja expirada e rejeitada',
    { expires_at: 0n },
    'AttestationExpired'
  );

  async function createSettlement(expiresAt = futureExpiry) {
    const id = randomBytes(32);

    const [address, bump] = PublicKey.findProgramAddressSync(
      [Buffer.from('settlement'), id],
      PROGRAM
    );

    const creation = await send(
      instruction('create_settlement', {
        config,
        attestation_authority: attestor.publicKey,
        corridor,
        payer: payer.publicKey,
        settlement: address,
        system_program: SystemProgram.programId,
      }, {
        settlement_id: id,
        amount_in: amountIn,
        amount_out: amountOut,
        expires_at: expiresAt,
        source_mint: pgbrl,
        destination_mint: pypyg,
        recipient: recipient.publicKey,
        liquidity_authority: liquidity.publicKey,
      }),
      payer,
      [attestor]
    );

    const before = await snapshot(
      accounts,
      address,
      creation.slot
    );

    assertEvent(
      creation.meta.logMessages ?? [],
      'SettlementCreated'
    );

    assert.deepEqual(before.state.settlement_id, id);
    assert.equal(before.state.corridor, corridor.toBase58());
    assert.equal(
      before.state.attestation_authority,
      attestor.publicKey.toBase58()
    );

    for (const [field, value] of Object.entries({
      payer: payer.publicKey,
      source_mint: pgbrl,
      destination_mint: pypyg,
      recipient: recipient.publicKey,
      liquidity_authority: liquidity.publicKey,
    })) {
      assert.equal(before.state[field], value.toBase58());
    }

    assert.equal(before.state.amount_in, amountIn);
    assert.equal(before.state.amount_out, amountOut);
    assert.equal(before.state.expires_at, expiresAt);
    assert.equal(before.state.bump, bump);
    assert.equal(before.state.status, 'Pending');

    return { id, address, before };
  }

  console.log('\nTESTE 1: happy path');

  const happy = await createSettlement();

  assert.deepEqual(
    happy.before.balances,
    [100_000_000n, 0n, amountOut, 0n]
  );

  const completed = await send(
    instruction('execute_settlement', {
      ...accounts,
      settlement: happy.address,
    }),
    payer,
    [liquidity]
  );

  const settled = await snapshot(
    accounts,
    happy.address,
    completed.slot
  );

  assert.deepEqual(
    settled.balances,
    [75_000_000n, amountIn, 0n, amountOut]
  );

  assert.deepEqual(settled.state, {
    ...happy.before.state,
    status: 'Settled',
  });

  const happyLogs = completed.meta.logMessages ?? [];

  assert(happyLogs.includes('Program log: Leg A CPI succeeded'));
  assert(happyLogs.includes('Program log: Leg B CPI succeeded'));
  assertEvent(happyLogs, 'SettlementExecuted');

  showBalances(happy.before, settled);
  console.log('PASS: duas pernas e status Settled confirmados.');

  console.log('\nTESTE 2: rollback por falta de pyPYG na segunda perna');

  const rollback = await createSettlement();

  assert(
    rollback.before.balances[0] >= amountIn,
    'Leg A precisa ter saldo suficiente'
  );

  assert.equal(
    rollback.before.balances[2],
    0n,
    'Leg B deve estar sem liquidez'
  );

  const failed = await send(
    instruction('execute_settlement', {
      ...accounts,
      settlement: rollback.address,
    }),
    payer,
    [liquidity],
    true
  );

  const logs = failed.meta.logMessages ?? [];
  console.log(logs.join('\n'));

  assert.deepEqual(failed.meta.err, {
    InstructionError: [0, { Custom: 1 }],
  });

  const legAIndex = logs.indexOf(
    'Program log: Leg A CPI succeeded'
  );

  assert(
    legAIndex >= 0,
    'Leg A nao chegou a completar a CPI'
  );

  const legBLogs = logs.slice(legAIndex + 1);

  assert(
    legBLogs.some(line =>
      line.startsWith(`Program ${TOKEN_2022_PROGRAM_ID} invoke [`)
    ),
    'A segunda CPI Token-2022 nao foi chamada'
  );

  assert(
    legBLogs.some(line =>
      line.startsWith(`Program ${TOKEN_2022_PROGRAM_ID} failed:`)
    ),
    'Falta evidencia de falha na segunda CPI Token-2022'
  );

  assert(
    !logs.includes('Program log: Leg B CPI succeeded')
  );

  assertNoEvent(logs, 'SettlementExecuted');

  const reverted = await snapshot(
    accounts,
    rollback.address,
    failed.slot
  );

  assert.deepEqual(
    reverted.balances,
    rollback.before.balances,
    'Saldos nao reverteram'
  );

  assert.deepEqual(
    reverted.raw,
    rollback.before.raw,
    'Dados de alguma conta nao reverteram'
  );

  assert.equal(reverted.state.status, 'Pending');

  showBalances(rollback.before, reverted);

  console.log(
    'PASS: Leg A executou, Leg B falhou, quatro contas e Settlement preservadas.'
  );

  await mintTo(
    connection,
    payer,
    pypyg,
    accounts.liquidity_pypyg,
    payer,
    amountOut,
    [],
    OPTIONS,
    TOKEN_2022_PROGRAM_ID
  );

  async function expectRejected(
    label,
    ix,
    signers,
    settlement,
    status,
    verifyError
  ) {
    console.log(`\n${label}`);

    const before = await snapshot(accounts, settlement);

    assert.equal(before.state.status, status);
    assert(
      before.balances[0] >= amountIn,
      'Leg A deve ter saldo suficiente'
    );
    assert(
      before.balances[2] >= amountOut,
      'Leg B deve ter liquidez suficiente'
    );

    const result = await send(
      ix,
      payer,
      signers,
      true
    );

    const rejectionLogs = result.meta.logMessages ?? [];
    console.log(rejectionLogs.join('\n'));

    verifyError(result.meta.err, rejectionLogs);

    assertNoEvent(rejectionLogs, 'SettlementCreated');
    assertNoEvent(rejectionLogs, 'SettlementExecuted');

    assert(
      !rejectionLogs.some(line =>
        line.startsWith(`Program ${TOKEN_2022_PROGRAM_ID} invoke [`)
      ),
      'A rejeicao deveria ocorrer antes de chamar Token-2022'
    );

    const after = await snapshot(
      accounts,
      settlement,
      result.slot
    );

    assert.deepEqual(
      after.balances,
      before.balances,
      'Rejeicao alterou saldos'
    );

    assert.deepEqual(
      after.raw,
      before.raw,
      'Rejeicao alterou dados de alguma conta'
    );

    assert.deepEqual(
      after.state,
      before.state,
      'Rejeicao alterou Settlement'
    );

    showBalances(before, after);
    console.log('PASS: rejeicao esperada e contas preservadas.');
  }

  const shortExpiry = BigInt(
    Math.floor(Date.now() / 1000) + 5
  );

  const expiring = await createSettlement(shortExpiry);

  await delay(6000);

  await expectRejected(
    'TESTE 3: autorizacao expira antes da execucao',
    instruction('execute_settlement', {
      ...accounts,
      settlement: expiring.address,
    }),
    [liquidity],
    expiring.address,
    'Pending',
    anchorError('AttestationExpired')
  );

  await expectRejected(
    'TESTE 4: troca de corredor na execucao e rejeitada',
    instruction('execute_settlement', {
      ...accounts,
      corridor: alternateCorridor,
      settlement: rollback.address,
    }),
    [liquidity],
    rollback.address,
    'Pending',
    anchorError('InvalidCorridor', 'corridor')
  );

  await expectRejected(
    'TESTE 5: executar novamente uma Settlement liquidada',
    instruction('execute_settlement', {
      ...accounts,
      settlement: happy.address,
    }),
    [liquidity],
    happy.address,
    'Settled',
    anchorError('AlreadySettled')
  );

  await expectRejected(
    'TESTE 6: criar novamente o mesmo settlement_id',
    instruction('create_settlement', {
      config,
      attestation_authority: attestor.publicKey,
      corridor,
      payer: payer.publicKey,
      settlement: happy.address,
      system_program: SystemProgram.programId,
    }, {
      settlement_id: happy.id,
      amount_in: amountIn,
      amount_out: amountOut,
      expires_at: futureExpiry,
      source_mint: pgbrl,
      destination_mint: pypyg,
      recipient: recipient.publicKey,
      liquidity_authority: liquidity.publicKey,
    }),
    [attestor],
    happy.address,
    'Settled',
    (error, rejectionLogs) => {
      assert.deepEqual(error, {
        InstructionError: [0, { Custom: 0 }],
      });

      assert(
        rejectionLogs.some(line =>
          /already in use/i.test(line) &&
          line.includes(happy.address.toBase58())
        ),
        'Falta evidencia de que a PDA existente impediu a criacao'
      );

      assert(
        rejectionLogs.some(line =>
          line.startsWith(
            `Program ${SystemProgram.programId} failed:`
          )
        ),
        'A falha esperada deve vir da tentativa de inicializacao pelo System Program'
      );
    }
  );

  const intruder = Keypair.generate();

  await expectRejected(
    'TESTE 7: payer nao autorizado',
    instruction('execute_settlement', {
      ...accounts,
      settlement: rollback.address,
      payer: intruder.publicKey,
    }),
    [intruder, liquidity],
    rollback.address,
    'Pending',
    anchorError('Unauthorized', 'payer')
  );

  await expectRejected(
    'TESTE 8: provedor nao autorizado',
    instruction('execute_settlement', {
      ...accounts,
      settlement: rollback.address,
      liquidity_authority: intruder.publicKey,
    }),
    [intruder],
    rollback.address,
    'Pending',
    anchorError('Unauthorized', 'liquidity_authority')
  );

  passed += 8;

  const pauseIx = (signer, paused) =>
    instruction('set_paused', {
      config,
      admin: signer.publicKey,
    }, {
      paused,
    });

  const beforeUnauthorizedPause = await configSnapshot();
  checkConfig(beforeUnauthorizedPause.state, false);

  await expectRejected(
    'TESTE 9: intruso nao pode pausar',
    pauseIx(intruder, true),
    [intruder],
    rollback.address,
    'Pending',
    anchorError('Unauthorized', 'config')
  );

  assert.deepEqual(
    (await configSnapshot()).raw,
    beforeUnauthorizedPause.raw
  );

  passed++;

  console.log('\nTESTE 10: admin pausa a execucao');

  const beforePause = await snapshot(
    accounts,
    rollback.address
  );

  const paused = await send(
    pauseIx(admin, true),
    payer,
    [admin]
  );

  checkConfig(
    (await configSnapshot(paused.slot)).state,
    true
  );

  assertNoTokenCpi(paused.meta.logMessages ?? []);

  assert.deepEqual(
    (
      await snapshot(
        accounts,
        rollback.address,
        paused.slot
      )
    ).raw,
    beforePause.raw
  );

  console.log(
    'PASS: paused=true; Settlement e quatro contas de tokens preservadas.'
  );

  passed++;

  const beforePausedExecution = await configSnapshot();

  await expectRejected(
    'TESTE 11: execucao pausada falha antes das transferencias',
    instruction('execute_settlement', {
      ...accounts,
      settlement: rollback.address,
    }),
    [liquidity],
    rollback.address,
    'Pending',
    anchorError('ProgramPaused')
  );

  assert.deepEqual(
    (await configSnapshot()).raw,
    beforePausedExecution.raw
  );

  passed++;

  await expectRejected(
    'TESTE 12: intruso nao pode retirar a pausa',
    pauseIx(intruder, false),
    [intruder],
    rollback.address,
    'Pending',
    anchorError('Unauthorized', 'config')
  );

  assert.deepEqual(
    (await configSnapshot()).raw,
    beforePausedExecution.raw
  );

  passed++;

  console.log(
    '\nTESTE 13: admin retoma e a mesma Settlement pode ser executada'
  );

  const beforeResume = await snapshot(
    accounts,
    rollback.address
  );

  const resumed = await send(
    pauseIx(admin, false),
    payer,
    [admin]
  );

  const configAfterResume = await configSnapshot(
    resumed.slot
  );

  checkConfig(configAfterResume.state, false);
  assertNoTokenCpi(resumed.meta.logMessages ?? []);

  assert.deepEqual(
    (
      await snapshot(
        accounts,
        rollback.address,
        resumed.slot
      )
    ).raw,
    beforeResume.raw
  );

  const executed = await send(
    instruction('execute_settlement', {
      ...accounts,
      settlement: rollback.address,
    }),
    payer,
    [liquidity]
  );

  const afterResume = await snapshot(
    accounts,
    rollback.address,
    executed.slot
  );

  const [
    payerBalance,
    lpIn,
    lpOut,
    recipientBalance,
  ] = beforeResume.balances;

  assert.deepEqual(afterResume.balances, [
    payerBalance - amountIn,
    lpIn + amountIn,
    lpOut - amountOut,
    recipientBalance + amountOut,
  ]);

  assert.deepEqual(afterResume.state, {
    ...beforeResume.state,
    status: 'Settled',
  });

  assert(
    (executed.meta.logMessages ?? [])
      .includes('Program log: Leg A CPI succeeded')
  );

  assert(
    (executed.meta.logMessages ?? [])
      .includes('Program log: Leg B CPI succeeded')
  );

  assertEvent(
    executed.meta.logMessages ?? [],
    'SettlementExecuted'
  );

  assert.deepEqual(
    (await configSnapshot(executed.slot)).raw,
    configAfterResume.raw
  );

  showBalances(beforeResume, afterResume);

  console.log(
    'PASS: paused=false; duas pernas confirmadas; mesma Settlement agora Settled.'
  );

  passed++;

  const expected = existingConfig ? 21 : 23;

  assert.equal(passed, expected);

  console.log(
    `\n${passed}/${expected} testes passaram no validator local.`
  );

  if (existingConfig) {
    console.log(
      'Os dois casos de primeira inicializacao nao foram executados nesta rodada.'
    );
  }
}

main().catch(error => {
  console.error('\nFAIL:', error.message);

  if (error.logs) {
    console.error(error.logs.join('\n'));
  }

  if (error.actual !== undefined) {
    console.error('Actual:', error.actual);
  }

  if (error.expected !== undefined) {
    console.error('Expected:', error.expected);
  }

  process.exitCode = 1;
});
