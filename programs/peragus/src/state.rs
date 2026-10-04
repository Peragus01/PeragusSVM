use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum SettlementStatus {
    Pending,
    Settled,
}

#[account]
#[derive(InitSpace)]
pub struct Settlement {
    pub settlement_id: [u8; 32],
    pub payer: Pubkey,
    pub source_mint: Pubkey,
    pub destination_mint: Pubkey,
    pub recipient: Pubkey,
    pub liquidity_authority: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub created_at: i64,
    pub status: SettlementStatus,
    pub bump: u8,
}
