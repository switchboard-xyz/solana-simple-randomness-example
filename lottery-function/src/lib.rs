use std::result::Result;
use switchboard_solana::{prelude::*, solana_client::rpc_client::RpcClient};

// The program ID doesnt matter here because the method were using
// to fetch an account doesnt check the account owner and only checks
// the discriminator which only depends on the AccountName.
declare_id!("6AKXZiKbmj3D45bDZpa9fo6vUV4qGeeeRCZ5qRhE4Ve4");

pub const PROGRAM_SEED: &[u8] = b"SIMPLE_LOTTERY";
pub const LOTTERY_SEED: &[u8] = b"LOTTERY_STATE";

/// The maximum number of tickets allowed to enter a lottery.
/// This could be dynamic but for this example its hard coded.
pub const MAX_TICKETS: usize = 256;

/// The default number of slots per lottery.
pub const DEFAULT_LOTTERY_DURATION_SLOTS: u32 = 9000; // ~1 hour at 400 ms/slot

pub async fn load_account<T: bytemuck::Pod + Discriminator>(
    client: &solana_client::rpc_client::RpcClient,
    pubkey: Pubkey,
    program_id: Pubkey,
) -> Result<T, SbError> {
    let account = client
        .get_account(&pubkey)
        .map_err(|_| SbError::CustomMessage("AnchorParseError".to_string()))?;

    if account.owner != program_id {
        return Err(SbError::CustomMessage(
            "Account is not owned by this program".to_string(),
        ));
    }

    if account.data.len() < T::discriminator().len() {
        return Err(SbError::CustomMessage(
            "no discriminator found".to_string(),
        ));
    }

    let mut disc_bytes = [0u8; 8];
    disc_bytes.copy_from_slice(&account.data[..8]);
    if disc_bytes != T::discriminator() {
        return Err(SbError::CustomMessage(
            "Discriminator error, check the account type".to_string(),
        ));
    }

    Ok(*bytemuck::try_from_bytes::<T>(&account.data[8..])
        .map_err(|_| SbError::CustomMessage("AnchorParseError".to_string()))?)
}

/// Represents the global state of the program.
/// Used to enforce the same Switchboard Function is used for each lottery.
#[account(zero_copy(unsafe))]
pub struct ProgramState {
    /// PDA bump seed.
    pub bump: u8,
    /// Account authorized to make config changes.
    pub authority: Pubkey,
    /// Switchboard Function pubkey.
    pub switchboard_function: Pubkey,
}
impl ProgramState {
    pub async fn fetch(
        client: &RpcClient,
        pubkey: &Pubkey,
        program_id: &Pubkey,
    ) -> std::result::Result<Self, SbError> {
        load_account(client, *pubkey, *program_id).await
    }
}

/// Represents the state of a lottery
#[account(zero_copy(unsafe))]
pub struct LotteryState {
    /// PDA bump seed.
    pub bump: u8,
    /// Account authorized to make config changes.
    pub authority: Pubkey,
    ///
    pub escrow: Pubkey,
    /// Switchboard Function Request pubkey.
    pub switchboard_request: Pubkey,

    // Duration config
    /// The slot when the lottery will open.
    pub open_slot: u64,
    /// The slot when the lottery will conclude.
    pub close_slot: u64,

    // Ticket config
    /// The current number of tickets sold.
    pub num_tickets: u32,
    /// The price of a ticket in SOL.
    pub entry_fee: u64,

    // Results config
    pub winner: Pubkey,
    pub has_ended: bool,

    // Data
    pub tickets: [Pubkey; MAX_TICKETS],
}
impl LotteryState {
    pub async fn fetch(
        client: &RpcClient,
        pubkey: &Pubkey,
        program_id: &Pubkey,
    ) -> std::result::Result<Self, SbError> {
        load_account(client, *pubkey, *program_id).await
    }
}
