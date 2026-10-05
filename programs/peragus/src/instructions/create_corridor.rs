use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::{
    token_2022,
    token_interface::Mint,
};

use crate::{
    constants::{CONFIG_SEED, CORRIDOR_SEED},
    error::ErrorCode,
    state::{Config, Corridor},
};

#[derive(Accounts)]
#[instruction(corridor_id: [u8; 32])]
pub struct CreateCorridor<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(
        owner = token_2022::ID
    )]
    pub source_mint: InterfaceAccount<'info, Mint>,

    #[account(
        owner = token_2022::ID,
        constraint = destination_mint.key() != source_mint.key()
            @ ErrorCode::InvalidMint
    )]
    pub destination_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = 8 + Corridor::INIT_SPACE,
        seeds = [CORRIDOR_SEED, corridor_id.as_ref()],
        bump
    )]
    pub corridor: Account<'info, Corridor>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_corridor(
    ctx: Context<CreateCorridor>,
    corridor_id: [u8; 32],
    liquidity_authority: Pubkey,
) -> Result<()> {
    require!(
        liquidity_authority != Pubkey::default(),
        ErrorCode::InvalidLiquidityAuthority
    );

    // Mesma restricao de mints adotada na execucao do settlement.
    let base_mint_len = token_2022::spl_token_2022::state::Mint::LEN;

    require!(
        ctx.accounts.source_mint.to_account_info().data_len()
            == base_mint_len
            && ctx.accounts.destination_mint.to_account_info().data_len()
                == base_mint_len,
        ErrorCode::UnsupportedMintExtensions
    );

    let corridor = &mut ctx.accounts.corridor;

    corridor.corridor_id = corridor_id;
    corridor.source_mint = ctx.accounts.source_mint.key();
    corridor.destination_mint = ctx.accounts.destination_mint.key();
    corridor.liquidity_authority = liquidity_authority;
    corridor.bump = ctx.bumps.corridor;

    msg!(
        "Corridor created: source_mint={}, destination_mint={}, liquidity_authority={}",
        corridor.source_mint,
        corridor.destination_mint,
        corridor.liquidity_authority
    );

    Ok(())
}
