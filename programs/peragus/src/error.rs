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
}
