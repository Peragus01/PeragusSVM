use anchor_lang::prelude::*;

use crate::{
    constants::CONFIG_SEED,
    error::ErrorCode,
    program::Peragus,
    state::Config,
};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    // Program<Peragus> valida o Program ID e exige conta executavel.
    #[account(
        constraint = peragus_program.programdata_address()?
            == Some(program_data.key())
            @ ErrorCode::InvalidProgramData
    )]
    pub peragus_program: Program<'info, Peragus>,

    // Account<ProgramData> valida o tipo e o owner do loader.
    #[account(
        constraint = program_data.upgrade_authority_address
            == Some(admin.key())
            @ ErrorCode::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(
    ctx: Context<InitializeConfig>,
    attestation_authority: Pubkey,
) -> Result<()> {
    require!(
        attestation_authority != Pubkey::default(),
        ErrorCode::InvalidAttestationAuthority
    );

    let config = &mut ctx.accounts.config;

    config.admin = ctx.accounts.admin.key();
    config.attestation_authority = attestation_authority;
    config.paused = false;
    config.bump = ctx.bumps.config;

    msg!(
        "Config initialized: admin={}, attestation_authority={}",
        config.admin,
        config.attestation_authority
    );

    Ok(())
}
