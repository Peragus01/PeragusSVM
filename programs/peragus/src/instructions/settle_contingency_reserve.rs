use anchor_lang::prelude::*;
use anchor_spl::{
    token_2022::{self, TransferChecked},
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{
    constants::{CONFIG_SEED, CONTINGENCY_RESERVE_SEED, CORRIDOR_SEED},
    error::ErrorCode,
    events::ContingencyReserveSettled,
    state::{
        Config, ContingencyReserve, ContingencyReserveStatus,
        Corridor,
    },
};

#[derive(Accounts)]
pub struct SettleContingencyReserve<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = attestation_authority
            @ ErrorCode::InvalidAttestationAuthority
    )]
    pub config: Account<'info, Config>,

    pub attestation_authority: Signer<'info>,

    #[account(
        mut,
        seeds = [
            CONTINGENCY_RESERVE_SEED,
            reserve.settlement_id.as_ref()
        ],
        bump = reserve.bump,
        constraint = reserve.attestation_authority
            == attestation_authority.key()
            @ ErrorCode::InvalidAttestationAuthority
    )]
    pub reserve: Box<Account<'info, ContingencyReserve>>,

    #[account(
        seeds = [CORRIDOR_SEED, corridor.corridor_id.as_ref()],
        bump = corridor.bump,
        address = reserve.corridor @ ErrorCode::InvalidCorridor,
        constraint = corridor.destination_mint
            == reserve.mint @ ErrorCode::InvalidMint,
        constraint = corridor.liquidity_authority
            == reserve.liquidity_authority
            @ ErrorCode::InvalidLiquidityAuthority
    )]
    pub corridor: Box<Account<'info, Corridor>>,

    #[account(
        address = reserve.mint @ ErrorCode::InvalidMint,
        owner = token_2022::ID
    )]
    pub destination_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        address = reserve.vault @ ErrorCode::InvalidTokenAccount,
        owner = token_2022::ID,
        constraint = reserve_vault.mint
            == destination_mint.key() @ ErrorCode::InvalidMint,
        constraint = reserve_vault.owner
            == reserve.key() @ ErrorCode::Unauthorized
    )]
    pub reserve_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        owner = token_2022::ID,
        constraint = recipient_destination.mint
            == destination_mint.key() @ ErrorCode::InvalidMint,
        constraint = recipient_destination.owner
            == reserve.recipient @ ErrorCode::Unauthorized,
        constraint = recipient_destination.key()
            != reserve_vault.key() @ ErrorCode::InvalidTokenAccount
    )]
    pub recipient_destination: InterfaceAccount<'info, TokenAccount>,

    #[account(address = token_2022::ID)]
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_settle_contingency_reserve(
    ctx: Context<SettleContingencyReserve>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let reserve = &ctx.accounts.reserve;

    require!(!ctx.accounts.config.paused, ErrorCode::ProgramPaused);
    require!(
        reserve.status == ContingencyReserveStatus::Funded,
        ErrorCode::ReserveAlreadyFinalized
    );
    require!(
        now >= reserve.fallback_after,
        ErrorCode::ReserveFallbackNotReady
    );
    require!(now < reserve.expires_at, ErrorCode::ReserveExpired);
    require!(
        ctx.accounts.reserve_vault.amount >= reserve.amount,
        ErrorCode::InvalidAmount
    );

    let settlement_id = reserve.settlement_id;
    let bump = [reserve.bump];
    let signer_seeds: &[&[u8]] = &[
        CONTINGENCY_RESERVE_SEED,
        settlement_id.as_ref(),
        &bump,
    ];

    token_2022::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.reserve_vault.to_account_info(),
                mint: ctx.accounts.destination_mint.to_account_info(),
                to: ctx.accounts.recipient_destination.to_account_info(),
                authority: ctx.accounts.reserve.to_account_info(),
            },
            &[signer_seeds],
        ),
        reserve.amount,
        ctx.accounts.destination_mint.decimals,
    )?;

    let reserve = &mut ctx.accounts.reserve;
    reserve.status = ContingencyReserveStatus::Settled;

    emit!(ContingencyReserveSettled {
        reserve: reserve.key(),
        vault: reserve.vault,
        settlement_id: reserve.settlement_id,
        recipient: reserve.recipient,
        mint: reserve.mint,
        amount: reserve.amount,
        settled_at: now,
    });

    msg!("Contingency reserve used: amount={}", reserve.amount);

    Ok(())
}
