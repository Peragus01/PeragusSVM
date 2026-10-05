use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Unauthorized operation")]
    Unauthorized,

    #[msg("Settlement amounts must be greater than zero")]
    InvalidAmount,

    #[msg("Settlement has already been settled")]
    AlreadySettled,

    #[msg("Settlement is in an invalid status for this operation")]
    InvalidSettlementStatus,

    #[msg("Invalid settlement mint")]
    InvalidMint,

    #[msg("Invalid settlement token account")]
    InvalidTokenAccount,

    #[msg("This demo currently supports only mints without extensions")]
    UnsupportedMintExtensions,

    #[msg("ProgramData does not belong to the Peragus program")]
    InvalidProgramData,

    #[msg("Settlement execution is paused")]
    ProgramPaused,

    #[msg("Invalid liquidity authority")]
    InvalidLiquidityAuthority,

    #[msg("Settlement does not belong to this corridor")]
    InvalidCorridor,
}
