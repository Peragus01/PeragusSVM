use anchor_lang::prelude::*;

use crate::{
    constants::SETTLEMENT_SEED,
    error::ErrorCode,
    state::{Settlement, SettlementStatus},
};

#[derive(Accounts)]
pub struct ExecuteSettlement<'info> {
    #[account(
        mut,
        seeds = [
            SETTLEMENT_SEED,
            settlement.settlement_id.as_ref()
        ],
        bump = settlement.bump
    )]
    pub settlement: Account<'info, Settlement>,

    pub payer: Signer<'info>,
}

pub fn handle_execute_settlement(
    ctx: Context<ExecuteSettlement>,
) -> Result<()> {
    let settlement = &mut ctx.accounts.settlement;

    require_keys_eq!(
        settlement.payer,
        ctx.accounts.payer.key(),
        ErrorCode::Unauthorized
    );

    require!(
        settlement.status == SettlementStatus::Pending,
        ErrorCode::AlreadySettled
    );

    settlement.status = SettlementStatus::Settled;

    msg!(
        "Settlement executed: amount_in={}, amount_out={}",
        settlement.amount_in,
        settlement.amount_out
    );

    Ok(())
}
