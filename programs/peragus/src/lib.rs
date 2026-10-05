pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("6Auy8BXWNaWQCAEbDkusoDkAjWvyzhkKw2LbfiVvvb1w");

#[program]
pub mod peragus {
    use super::*;

    pub fn set_paused(
        ctx: Context<SetPaused>,
        paused: bool,
    ) -> Result<()> {
        crate::instructions::set_paused::handle_set_paused(ctx, paused)
    }

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
    ) -> Result<()> {
        crate::instructions::initialize_config::handle_initialize_config(ctx)
    }

    pub fn create_settlement(
        ctx: Context<CreateSettlement>,
        settlement_id: [u8; 32],
        amount_in: u64,
        amount_out: u64,
        source_mint: Pubkey,
        destination_mint: Pubkey,
        recipient: Pubkey,
        liquidity_authority: Pubkey,
    ) -> Result<()> {
        crate::instructions::create_settlement::handle_create_settlement(
            ctx,
            settlement_id,
            amount_in,
            amount_out,
            source_mint,
            destination_mint,
            recipient,
            liquidity_authority,
        )
    }

    pub fn execute_settlement(
        ctx: Context<ExecuteSettlement>,
    ) -> Result<()> {
        crate::instructions::execute_settlement::handle_execute_settlement(ctx)
    }
}
