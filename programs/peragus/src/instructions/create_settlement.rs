use anchor_lang::prelude::*;

use crate::{constants::SETTLEMENT_SEED, state::Settlement};

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
) -> Result<()> {
    let settlement = &mut ctx.accounts.settlement;

    settlement.settlement_id = settlement_id;
    settlement.payer = ctx.accounts.payer.key();
    settlement.amount_in = amount_in;
    settlement.amount_out = amount_out;
    settlement.created_at = Clock::get()?.unix_timestamp;
    settlement.status = 0;
    settlement.bump = ctx.bumps.settlement;

    msg!(
        "Settlement created: amount_in={}, amount_out={}",
        amount_in,
        amount_out
    );

    Ok(())
}
