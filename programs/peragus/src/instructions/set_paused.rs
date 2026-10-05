use anchor_lang::prelude::*;

use crate::{
    constants::CONFIG_SEED,
    error::ErrorCode,
    state::Config,
};

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ ErrorCode::Unauthorized
    )]
    pub config: Account<'info, Config>,

    pub admin: Signer<'info>,
}

pub fn handle_set_paused(
    ctx: Context<SetPaused>,
    paused: bool,
) -> Result<()> {
    ctx.accounts.config.paused = paused;

    msg!(
        "Pause updated: admin={}, paused={}",
        ctx.accounts.admin.key(),
        paused
    );

    Ok(())
}
