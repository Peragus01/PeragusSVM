use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum SettlementStatus {
    Pending,
    Settled,
}

#[account]
#[derive(InitSpace)]
pub struct Settlement {
    pub corridor: Pubkey,
    pub attestation_authority: Pubkey,
    pub settlement_id: [u8; 32],
    pub payer: Pubkey,
    pub source_mint: Pubkey,
    pub destination_mint: Pubkey,
    pub recipient: Pubkey,
    pub liquidity_authority: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub created_at: i64,
    pub expires_at: i64,
    pub status: SettlementStatus,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub attestation_authority: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Corridor {
    pub corridor_id: [u8; 32],
    pub source_mint: Pubkey,
    pub destination_mint: Pubkey,
    pub liquidity_authority: Pubkey,
    pub bump: u8,
}
