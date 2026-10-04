use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Settlement {
    pub settlement_id: [u8; 32],
    pub payer: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub created_at: i64,
    pub status: u8,
    pub bump: u8,
}
