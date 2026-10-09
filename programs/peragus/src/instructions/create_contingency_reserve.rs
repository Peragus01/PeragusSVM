use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::{
    token_2022::{self, TransferChecked},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::{
        CONFIG_SEED, CONTINGENCY_RESERVE_SEED,
        CONTINGENCY_VAULT_SEED, CORRIDOR_SEED,
    },
    error::ErrorCode,
    events::ContingencyReserveFunded,
    state::{
        Config, ContingencyReserve, ContingencyReserveStatus,
        Corridor,
    },
};

#[derive(Accounts)]
#[instruction(settlement_id: [u8; 32])]
pub struct CreateContingencyReserve<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = attestation_authority
            @ ErrorCode::InvalidAttestationAuthority
    )]
    pub config: Account<'info, Config>,

    pub attestation_authority: Signer<'info>,

    #[account(
        seeds = [CORRIDOR_SEED, corridor.corridor_id.as_ref()],
        bump = corridor.bump,
        has_one = liquidity_authority
            @ ErrorCode::InvalidLiquidityAuthority
    )]
    pub corridor: Box<Account<'info, Corridor>>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub liquidity_authority: Signer<'info>,

    #[account(
        address = corridor.destination_mint @ ErrorCode::InvalidMint,
        owner = token_2022::ID
    )]
    pub destination_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        owner = token_2022::ID,
        constraint = liquidity_destination.mint
            == destination_mint.key() @ ErrorCode::InvalidMint,
        constraint = liquidity_destination.owner
            == liquidity_authority.key() @ ErrorCode::Unauthorized
    )]
    pub liquidity_destination: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        space = 8 + ContingencyReserve::INIT_SPACE,
        seeds = [CONTINGENCY_RESERVE_SEED, settlement_id.as_ref()],
        bump
    )]
    pub reserve: Box<Account<'info, ContingencyReserve>>,

    #[account(
        init,
        payer = payer,
        seeds = [CONTINGENCY_VAULT_SEED, settlement_id.as_ref()],
        bump,
        token::mint = destination_mint,
        token::authority = reserve,
        token::token_program = token_program
    )]
    pub reserve_vault: InterfaceAccount<'info, TokenAccount>,

    pub system_program: Program<'info, System>,

    #[account(address = token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_create_contingency_reserve(
    ctx: Context<CreateContingencyReserve>,
    settlement_id: [u8; 32],
    amount: u64,
    fallback_after: i64,
    expires_at: i64,
    recipient: Pubkey,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    require!(!ctx.accounts.config.paused, ErrorCode::ProgramPaused);
    require!(amount > 0, ErrorCode::InvalidAmount);
    require!(
        fallback_after > now && expires_at > fallback_after,
        ErrorCode::InvalidReserveWindow
    );

    let base_mint_len = token_2022::spl_token_2022::state::Mint::LEN;

    require!(
        ctx.accounts.destination_mint.to_account_info().data_len()
            == base_mint_len,
        ErrorCode::UnsupportedMintExtensions
    );

    let reserve = &mut ctx.accounts.reserve;

    reserve.corridor = ctx.accounts.corridor.key();
    reserve.settlement_id = settlement_id;
    reserve.attestation_authority =
        ctx.accounts.attestation_authority.key();
    reserve.liquidity_authority =
        ctx.accounts.liquidity_authority.key();
    reserve.recipient = recipient;
    reserve.mint = ctx.accounts.destination_mint.key();
    reserve.vault = ctx.accounts.reserve_vault.key();
    reserve.amount = amount;
    reserve.fallback_after = fallback_after;
    reserve.expires_at = expires_at;
    reserve.status = ContingencyReserveStatus::Funded;
    reserve.bump = ctx.bumps.reserve;
    reserve.vault_bump = ctx.bumps.reserve_vault;

    token_2022::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.liquidity_destination.to_account_info(),
                mint: ctx.accounts.destination_mint.to_account_info(),
                to: ctx.accounts.reserve_vault.to_account_info(),
                authority: ctx.accounts.liquidity_authority.to_account_info(),
            },
        ),
        amount,
        ctx.accounts.destination_mint.decimals,
    )?;

    emit!(ContingencyReserveFunded {
        reserve: reserve.key(),
        vault: reserve.vault,
        settlement_id,
        corridor: reserve.corridor,
        liquidity_authority: reserve.liquidity_authority,
        recipient,
        mint: reserve.mint,
        amount,
        fallback_after,
        expires_at,
        funded_at: now,
    });

    msg!("Contingency reserve funded: amount={}", amount);

    Ok(())
}
