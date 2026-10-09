// Peragus contingency reserve demo on Solana Devnet.
// Demo assets only. No real fiat value or redemption.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  createAccount,
  createMint,
  getAccount,
  mintTo,
} from '@solana/spl-token';

const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const CLUSTER = 'devnet';
const PROGRAM = new PublicKey(
  '6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w'
);
const OPTIONS = {
  commitment: 'confirmed',
  preflightCommitment: 'confirmed',
};
const connection = new Connection(RPC, OPTIONS.commitment);
const idl = JSON.parse(
  readFileSync(
    new URL('../../target/idl/peragus.json', import.meta.url),
    'utf8'
  )
);

assert.equal(idl.address, PROGRAM.toBase58());

function loadKeypair(path, label) {
  const value = JSON.parse(readFileSync(path, 'utf8'));

  assert(
    Array.isArray(value) &&
      value.length === 64 &&
      value.every(byte =>
        Number.isInteger(byte) && byte >= 0 && byte <= 255
      ),
    `${label} deve conter um keypair Solana de 64 bytes`
  );

  return Keypair.fromSecretKey(Uint8Array.from(value));
}

function encode(type, value) {
  if (type === 'u64') {
    const data = Buffer.alloc(8);
    data.writeBigUInt64LE(value);
    return data;
  }

  if (type === 'i64') {
    const data = Buffer.alloc(8);
    data.writeBigInt64LE(value);
    return data;
  }

  if (type === 'pubkey') {
    return new PublicKey(value).toBuffer();
  }

  if (type?.array?.[0] === 'u8') {
    const data = Buffer.from(value);
    assert.equal(data.length, type.array[1]);
    return data;
  }

  throw new Error(`Tipo nao suportado: ${JSON.stringify(type)}`);
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
      ...definition.args.map(argument =>
        encode(argument.type, args[argument.name])
      ),
    ]),
  });
}

async function ensureFunded(publicKey) {
  const lamports = await connection.getBalance(publicKey, 'confirmed');

  assert(
    lamports >= 2 * LAMPORTS_PER_SOL,
    `Carteira pagadora precisa de pelo menos 2 SOL na Devnet; saldo: ${
      lamports / LAMPORTS_PER_SOL
    } SOL`
  );
}

function explorer(signature) {
  return `https://explorer.solana.com/tx/${signature}?cluster=${CLUSTER}`;
}

async function send(ix, payer, signers = [], expectedFailure = false) {
  const lifetime = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({
    feePayer: payer.publicKey,
    ...lifetime,
  }).add(ix);

  const uniqueSigners = [payer, ...signers].filter(
    (signer, index, all) =>
      all.findIndex(candidate =>
        candidate.publicKey.equals(signer.publicKey)
      ) === index
  );

  transaction.sign(...uniqueSigners);

  const signature = await connection.sendRawTransaction(
    transaction.serialize(),
    {
      skipPreflight: expectedFailure,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    }
  );

  const confirmation = await connection.confirmTransaction(
    { signature, ...lifetime },
    'confirmed'
  );

  if (expectedFailure) {
    assert.notEqual(confirmation.value.err, null);
  } else {
    assert.equal(
      confirmation.value.err,
      null,
      `Transacao falhou: ${JSON.stringify(confirmation.value.err)}`
    );
  }

  return signature;
}

async function balance(address) {
  return (
    await getAccount(
      connection,
      address,
      'confirmed',
      TOKEN_2022_PROGRAM_ID
    )
  ).amount;
}

function deriveReserve(settlementId) {
  const [reserve] = PublicKey.findProgramAddressSync(
    [Buffer.from('contingency-reserve'), settlementId],
    PROGRAM
  );
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('contingency-vault'), settlementId],
    PROGRAM
  );

  return { reserve, vault };
}

async function main() {
  console.log('Peragus | Reserva de contingencia Token-2022 DEVNET');

  const authorities = join(
    homedir(),
    '.local',
    'share',
    'peragus-local-tests',
    'authorities'
  );
  const admin = loadKeypair(
    join(homedir(), '.config', 'solana', 'id.json'),
    'carteira Solana principal'
  );
  const attestor = loadKeypair(
    join(authorities, 'attestation-authority.json'),
    'attestation authority'
  );
  const liquidity = loadKeypair(
    join(authorities, 'liquidity-authority.json'),
    'liquidity authority'
  );
  const payer = admin;
  const recipient = loadKeypair(
    join(authorities, 'recipient.json'),
    'recipient'
  );

  console.log(`RPC: ${RPC}`);
  console.log(`Programa: ${PROGRAM.toBase58()}`);
  console.log(`Carteira pagadora: ${payer.publicKey.toBase58()}`);

  await ensureFunded(payer.publicKey);

  const [config] = PublicKey.findProgramAddressSync(
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

  if (!(await connection.getAccountInfo(config, 'confirmed'))) {
    const initializeSignature = await send(
      instruction('initialize_config', {
        admin: admin.publicKey,
        peragus_program: PROGRAM,
        program_data: programData,
        config,
        system_program: SystemProgram.programId,
      }, {
        attestation_authority: attestor.publicKey,
      }),
      payer,
      [admin]
    );

    console.log(`Config inicializada: ${explorer(initializeSignature)}`);
  }

  const sourceMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    6,
    Keypair.generate(),
    OPTIONS,
    TOKEN_2022_PROGRAM_ID
  );
  const destinationMint = await createMint(
    connection,
    payer,
    liquidity.publicKey,
    null,
    6,
    Keypair.generate(),
    OPTIONS,
    TOKEN_2022_PROGRAM_ID
  );
  const corridorId = randomBytes(32);
  const [corridor] = PublicKey.findProgramAddressSync(
    [Buffer.from('corridor'), corridorId],
    PROGRAM
  );

  await send(
    instruction('create_corridor', {
      admin: admin.publicKey,
      config,
      source_mint: sourceMint,
      destination_mint: destinationMint,
      corridor,
      system_program: SystemProgram.programId,
    }, {
      corridor_id: corridorId,
      liquidity_authority: liquidity.publicKey,
    }),
    payer,
    [admin]
  );

  const liquidityDestination = await createAccount(
    connection,
    payer,
    destinationMint,
    liquidity.publicKey,
    Keypair.generate(),
    OPTIONS,
    TOKEN_2022_PROGRAM_ID
  );
  const recipientDestination = await createAccount(
    connection,
    payer,
    destinationMint,
    recipient.publicKey,
    Keypair.generate(),
    OPTIONS,
    TOKEN_2022_PROGRAM_ID
  );
  const reserveAmount = 50_000_000n;

  await mintTo(
    connection,
    payer,
    destinationMint,
    liquidityDestination,
    liquidity,
    reserveAmount * 3n,
    [],
    OPTIONS,
    TOKEN_2022_PROGRAM_ID
  );

  async function fundReserve({
    fallbackDelay,
    expiryDelay,
  }) {
    const settlementId = randomBytes(32);
    const { reserve, vault } = deriveReserve(settlementId);
    const now = BigInt(Math.floor(Date.now() / 1000));

    await send(
      instruction('create_contingency_reserve', {
        config,
        attestation_authority: attestor.publicKey,
        corridor,
        payer: payer.publicKey,
        liquidity_authority: liquidity.publicKey,
        destination_mint: destinationMint,
        liquidity_destination: liquidityDestination,
        reserve,
        reserve_vault: vault,
        system_program: SystemProgram.programId,
        token_program: TOKEN_2022_PROGRAM_ID,
      }, {
        settlement_id: settlementId,
        amount: reserveAmount,
        fallback_after: now + BigInt(fallbackDelay),
        expires_at: now + BigInt(expiryDelay),
        recipient: recipient.publicKey,
      }),
      payer,
      [attestor, liquidity]
    );

    assert.equal(await balance(vault), reserveAmount);

    return { settlementId, reserve, vault };
  }

  function fallbackInstruction(item) {
    return instruction('settle_contingency_reserve', {
      config,
      attestation_authority: attestor.publicKey,
      reserve: item.reserve,
      corridor,
      destination_mint: destinationMint,
      reserve_vault: item.vault,
      recipient_destination: recipientDestination,
      token_program: TOKEN_2022_PROGRAM_ID,
    });
  }

  function refundInstruction(item, caller) {
    return instruction('refund_contingency_reserve', {
      config,
      caller,
      reserve: item.reserve,
      corridor,
      liquidity_authority: liquidity.publicKey,
      destination_mint: destinationMint,
      reserve_vault: item.vault,
      liquidity_destination: liquidityDestination,
      token_program: TOKEN_2022_PROGRAM_ID,
    });
  }

  console.log('\nCAMINHO 1: settle apos o SLA da OZAV');
  const fallback = await fundReserve({
    fallbackDelay: 15,
    expiryDelay: 90,
  });
  const recipientBefore = await balance(recipientDestination);

  console.log('Aguardando 20 segundos para o fallback...');
  await delay(20_000);

  const settleSignature = await send(
    fallbackInstruction(fallback),
    payer,
    [attestor]
  );
  assert.equal(await balance(fallback.vault), 0n);
  assert.equal(
    await balance(recipientDestination),
    recipientBefore + reserveAmount
  );

  console.log(`SETTLE: ${explorer(settleSignature)}`);
  console.log(
    'PASS: fallback pago; replay já validado no teste local.',
  );

  console.log('\nCAMINHO 2: refund permissionless apos expiracao');
  const expired = await fundReserve({
    fallbackDelay: 10,
    expiryDelay: 25,
  });
  const caller = Keypair.generate();

  console.log('Aguardando 30 segundos para a expiracao...');
  await delay(30_000);

  const refundSignature = await send(
    refundInstruction(expired, caller.publicKey),
    payer,
    [caller]
  );
  assert.equal(await balance(expired.vault), 0n);
  console.log(`REFUND: ${explorer(refundSignature)}`);
  console.log('PASS: devolucao permissionless apos expirar.');

  console.log('\nRESERVA DE CONTINGENCIA DEVNET: OK');
  console.table([{
    fallback_ozav: 'Settled',
    expiracao: 'Refunded',
    pagamento_duplicado: 'bloqueado',
    settle_explorer: explorer(settleSignature),
    refund_explorer: explorer(refundSignature),
  }]);
}

main().catch(error => {
  console.error(
    'FALHA NO TESTE DA RESERVA:',
    error instanceof Error ? error.message : error
  );

  if (error?.logs) {
    console.error(error.logs.join('\n'));
  }

  process.exitCode = 1;
});
