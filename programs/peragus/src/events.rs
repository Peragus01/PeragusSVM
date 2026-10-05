use anchor_lang::prelude::*;

#[event]
pub struct CorridorCreated {
    pub corridor: Pubkey,
    pub corridor_id: [u8; 32],
    pub source_mint: Pubkey,
    pub destination_mint: Pubkey,
    pub liquidity_authority: Pubkey,
}

#[event]
pub struct SettlementCreated {
    pub settlement: Pubkey,
    pub settlement_id: [u8; 32],
    pub corridor: Pubkey,
    pub payer: Pubkey,
    pub recipient: Pubkey,
    pub source_mint: Pubkey,
    pub destination_mint: Pubkey,
    pub liquidity_authority: Pubkey,
    pub attestation_authority: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub expires_at: i64,
    pub created_at: i64,
}

#[event]
pub struct SettlementExecuted {
    pub settlement: Pubkey,
    pub settlement_id: [u8; 32],
    pub corridor: Pubkey,
    pub payer: Pubkey,
    pub recipient: Pubkey,
    pub source_mint: Pubkey,
    pub destination_mint: Pubkey,
    pub liquidity_authority: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub executed_at: i64,
}
