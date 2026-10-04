use anchor_lang::prelude::*;

use crate::{constants::SETTLEMENT_SEED, error::ErrorCode, state::{Settlement, SettlementStatus}};

#[derive(Accounts)]
#[instruction(settlement_id: [u8; 32])]
pub struct CreateSettlement<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Settlement::INIT_SPACE,
        seeds = [SETTLEMENT_SEED, settlement_id.as_ref()],
        bump
    )]
    pub settlement: Account<'info, Settlement>,

    pub system_program: Program<'info, System>,
}

pub fn handle_create_settlement(
    ctx: Context<CreateSettlement>,
    settlement_id: [u8; 32],
    amount_in: u64,
    amount_out: u64,
    source_mint: Pubkey,
    destination_mint: Pubkey,
    recipient: Pubkey,
    liquidity_authority: Pubkey,
) -> Result<()> {
    require!(
        amount_in > 0 && amount_out > 0,
        ErrorCode::InvalidAmount
    );

    let settlement = &mut ctx.accounts.settlement;

    settlement.settlement_id = settlement_id;
    settlement.payer = ctx.accounts.payer.key();
    settlement.source_mint = source_mint;
    settlement.destination_mint = destination_mint;
    settlement.recipient = recipient;
    settlement.liquidity_authority = liquidity_authority;
    settlement.amount_in = amount_in;
    settlement.amount_out = amount_out;
    settlement.created_at = Clock::get()?.unix_timestamp;
    settlement.status = SettlementStatus::Pending;
    settlement.bump = ctx.bumps.settlement;

    msg!(
        "Settlement created: amount_in={}, amount_out={}",
        amount_in,
        amount_out
    );

    Ok(())
}
