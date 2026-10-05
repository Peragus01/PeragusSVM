use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::{
    token_2022::{self, TransferChecked},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::{CONFIG_SEED, CORRIDOR_SEED, SETTLEMENT_SEED},
    error::ErrorCode,
    state::{Config, Corridor, Settlement, SettlementStatus},
};

#[derive(Accounts)]
pub struct ExecuteSettlement<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [
            SETTLEMENT_SEED,
            settlement.settlement_id.as_ref()
        ],
        bump = settlement.bump
    )]
    pub settlement: Box<Account<'info, Settlement>>,

    #[account(
        seeds = [CORRIDOR_SEED, corridor.corridor_id.as_ref()],
        bump = corridor.bump,
        address = settlement.corridor @ ErrorCode::InvalidCorridor,
        constraint = corridor.source_mint == settlement.source_mint
            @ ErrorCode::InvalidMint,
        constraint = corridor.destination_mint == settlement.destination_mint
            @ ErrorCode::InvalidMint,
        constraint = corridor.liquidity_authority == settlement.liquidity_authority
            @ ErrorCode::InvalidLiquidityAuthority
    )]
    pub corridor: Box<Account<'info, Corridor>>,

    #[account(
        address = settlement.payer @ ErrorCode::Unauthorized
    )]
    pub payer: Signer<'info>,

    #[account(
        address = settlement.liquidity_authority @ ErrorCode::Unauthorized
    )]
    pub liquidity_authority: Signer<'info>,

    #[account(
        address = settlement.source_mint @ ErrorCode::InvalidMint,
        owner = token_2022::ID
    )]
    pub source_mint: InterfaceAccount<'info, Mint>,

    #[account(
        address = settlement.destination_mint @ ErrorCode::InvalidMint,
        owner = token_2022::ID,
        constraint = destination_mint.key() != source_mint.key()
            @ ErrorCode::InvalidMint
    )]
    pub destination_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        owner = token_2022::ID,
        constraint = payer_pgbrl.mint == source_mint.key()
            @ ErrorCode::InvalidMint,
        constraint = payer_pgbrl.owner == payer.key()
            @ ErrorCode::Unauthorized
    )]
    pub payer_pgbrl: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        owner = token_2022::ID,
        constraint = liquidity_pgbrl.mint == source_mint.key()
            @ ErrorCode::InvalidMint,
        constraint = liquidity_pgbrl.owner == liquidity_authority.key()
            @ ErrorCode::Unauthorized,
        constraint = liquidity_pgbrl.key() != payer_pgbrl.key()
            @ ErrorCode::InvalidTokenAccount
    )]
    pub liquidity_pgbrl: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        owner = token_2022::ID,
        constraint = liquidity_pypyg.mint == destination_mint.key()
            @ ErrorCode::InvalidMint,
        constraint = liquidity_pypyg.owner == liquidity_authority.key()
            @ ErrorCode::Unauthorized
    )]
    pub liquidity_pypyg: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        owner = token_2022::ID,
        constraint = recipient_pypyg.mint == destination_mint.key()
            @ ErrorCode::InvalidMint,
        constraint = recipient_pypyg.owner == settlement.recipient
            @ ErrorCode::Unauthorized,
        constraint = recipient_pypyg.key() != liquidity_pypyg.key()
            @ ErrorCode::InvalidTokenAccount
    )]
    pub recipient_pypyg: InterfaceAccount<'info, TokenAccount>,

    #[account(address = token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_execute_settlement(
    ctx: Context<ExecuteSettlement>,
) -> Result<()> {
    require!(
        !ctx.accounts.config.paused,
        ErrorCode::ProgramPaused
    );

    require!(
        ctx.accounts.settlement.status == SettlementStatus::Pending,
        ErrorCode::AlreadySettled
    );

    let amount_in = ctx.accounts.settlement.amount_in;
    let amount_out = ctx.accounts.settlement.amount_out;

    require!(
        amount_in > 0 && amount_out > 0,
        ErrorCode::InvalidAmount
    );

    // Neste primeiro MVP, os mints devem ter somente o layout base.
    // Isso exclui extensoes como TransferFee e TransferHook.
    let base_mint_len = token_2022::spl_token_2022::state::Mint::LEN;

    require!(
        ctx.accounts.source_mint.to_account_info().data_len()
            == base_mint_len
            && ctx.accounts.destination_mint.to_account_info().data_len()
                == base_mint_len,
        ErrorCode::UnsupportedMintExtensions
    );

    // Leg A: payer envia pgBRL ao provedor.
    token_2022::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.payer_pgbrl.to_account_info(),
                mint: ctx.accounts.source_mint.to_account_info(),
                to: ctx.accounts.liquidity_pgbrl.to_account_info(),
                authority: ctx.accounts.payer.to_account_info(),
            },
        ),
        amount_in,
        ctx.accounts.source_mint.decimals,
    )?;

    msg!("Leg A CPI succeeded");

    // Leg B: provedor envia pyPYG ao destinatario.
    // Se esta CPI falhar, o ? propaga o erro da instrucao.
    token_2022::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.liquidity_pypyg.to_account_info(),
                mint: ctx.accounts.destination_mint.to_account_info(),
                to: ctx.accounts.recipient_pypyg.to_account_info(),
                authority: ctx.accounts.liquidity_authority.to_account_info(),
            },
        ),
        amount_out,
        ctx.accounts.destination_mint.decimals,
    )?;

    msg!("Leg B CPI succeeded");

    // Somente apos as duas CPIs terem sucesso.
    ctx.accounts.settlement.status = SettlementStatus::Settled;

    msg!(
        "Settlement completed: amount_in={}, amount_out={}",
        amount_in,
        amount_out
    );

    Ok(())
}
