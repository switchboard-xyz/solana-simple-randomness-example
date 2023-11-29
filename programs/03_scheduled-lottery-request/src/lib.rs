#![allow(clippy::result_large_err)]
// Program: Delayed Request
// This Solana program will allow you to initialize a lottery game with a Switchboard Function.
// Users can then buy tickets and enter into a drawing. When the lottery is initialized, a
// Switchboard request will be created and scheduled to execute when the lottery concludes.

use anchor_spl::token::{CloseAccount, Token, TokenAccount};
use switchboard_solana::prelude::*;

declare_id!("6AKXZiKbmj3D45bDZpa9fo6vUV4qGeeeRCZ5qRhE4Ve4");

pub const PROGRAM_SEED: &[u8] = b"SIMPLE_LOTTERY";
pub const LOTTERY_SEED: &[u8] = b"LOTTERY_STATE";

/// The maximum number of tickets allowed to enter a lottery.
/// This could be dynamic but for this example its hard coded.
pub const MAX_TICKETS: usize = 256;

/// The default number of slots per lottery.
pub const DEFAULT_LOTTERY_DURATION_SLOTS: u32 = 9000; // ~1 hour at 400 ms/slot

#[program]
pub mod scheduled_lottery_request {
    use switchboard_solana::wrap_native;

    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> anchor_lang::Result<()> {
        let mut program_state = ctx.accounts.program_state.load_init()?;

        program_state.bump = *ctx.bumps.get("program_state").unwrap();
        program_state.authority = *ctx.accounts.authority.key;
        program_state.switchboard_function = ctx.accounts.switchboard_function.key();

        Ok(())
    }

    pub fn create_lottery(
        ctx: Context<CreateLottery>,
        entry_fee: u64,
        duration_slots: Option<u32>,
    ) -> anchor_lang::Result<()> {
        // Parameters used by the Switchboard Function to determine the lottery winner.
        let request_params = format!("PID={},LOTTERY={}", crate::id(), ctx.accounts.lottery.key(),);
        let container_params = request_params.into_bytes();

        let lottery_settlement_slot = Clock::get()?.slot
            + u64::from(duration_slots.unwrap_or(DEFAULT_LOTTERY_DURATION_SLOTS));

        // Create the Switchboard request account.
        let request_init_ctx = FunctionRequestInit {
            request: ctx.accounts.switchboard_request.clone(),
            authority: ctx.accounts.lottery.to_account_info(),
            function: ctx.accounts.switchboard_function.to_account_info(),
            function_authority: None,
            escrow: ctx.accounts.switchboard_request_escrow.clone(),
            mint: ctx.accounts.switchboard_mint.to_account_info(),
            state: ctx.accounts.switchboard_state.to_account_info(),
            attestation_queue: ctx.accounts.switchboard_attestation_queue.to_account_info(),
            payer: ctx.accounts.payer.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
        };
        request_init_ctx.invoke(
            ctx.accounts.switchboard.clone(),
            // max_container_params_len - the length of the vec containing the container params
            // default: 256 bytes
            Some(container_params.len() as u32),
            // container_params - the container params
            // default: empty vec
            Some(container_params),
            // garbage_collection_slot - the slot when the request can be closed by anyone and is considered dead
            // default: None, only authority can close the request
            None,
        )?;

        // Then trigger it
        // We do this in two steps so we can set the authority to our Lottery PDA
        let trigger_ctx = FunctionRequestTrigger {
            request: ctx.accounts.switchboard_request.to_account_info(),
            authority: ctx.accounts.lottery.to_account_info(),
            escrow: ctx.accounts.switchboard_request_escrow.to_account_info(),
            function: ctx.accounts.switchboard_function.to_account_info(),
            state: ctx.accounts.switchboard_state.to_account_info(),
            attestation_queue: ctx.accounts.switchboard_attestation_queue.to_account_info(),
            payer: ctx.accounts.payer.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        trigger_ctx.invoke_signed(
            ctx.accounts.switchboard.clone(),
            // bounty - the amount of SOL to pay the Switchboard Function for executing the request
            None,
            // slots_until_expiration - the number of slots until the request expires
            None,
            // valid_after_slot - the slot when the request can be executed
            // !! IMPORTANT !! - we're scheduling our request to execute as soon as the lottery ends
            Some(lottery_settlement_slot),
            // Lottery PDA seeds
            &[&[
                LOTTERY_SEED,
                ctx.accounts.authority.key().as_ref(),
                &[*ctx.bumps.get("lottery").unwrap()],
            ]],
        )?;

        let mut lottery = ctx.accounts.lottery.load_init()?;
        lottery.bump = *ctx.bumps.get("lottery").unwrap();
        lottery.authority = ctx.accounts.authority.key();
        lottery.escrow = ctx.accounts.lottery_escrow.key();
        lottery.switchboard_request = ctx.accounts.switchboard_request.key();
        lottery.entry_fee = entry_fee;

        lottery.open_slot = Clock::get()?.slot;
        lottery.close_slot = lottery_settlement_slot;

        Ok(())
    }

    pub fn buy_ticket(ctx: Context<BuyTicket>) -> anchor_lang::Result<()> {
        if ctx.accounts.lottery.load()?.num_tickets >= MAX_TICKETS as u32 {
            return Err(error!(LotteryError::LotterySoldOut));
        }

        if ctx.accounts.lottery.load()?.close_slot < Clock::get()?.slot {
            return Err(error!(LotteryError::LotteryAlreadyEnded));
        }

        wrap_native(
            &ctx.accounts.system_program.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.escrow,
            &ctx.accounts.payer.to_account_info(),
            &[&[
                LOTTERY_SEED,
                ctx.accounts.lottery.load()?.authority.key().as_ref(),
                &[ctx.accounts.lottery.load()?.bump],
            ]],
            ctx.accounts.lottery.load()?.entry_fee,
        )?;

        let mut lottery = ctx.accounts.lottery.load_mut()?;
        let num_tickets = lottery.num_tickets as usize;
        lottery.tickets[num_tickets] = ctx.accounts.payer.key();
        lottery.num_tickets += 1;

        emit!(LotteryTicketPurchased {
            lottery: ctx.accounts.lottery.key(),
            user: ctx.accounts.payer.key(),
            entry_fee: lottery.entry_fee,
            num_tickets: lottery.num_tickets
        });

        Ok(())
    }

    pub fn draw_winner(ctx: Context<DrawWinner>, winner: Pubkey) -> anchor_lang::Result<()> {
        if ctx.accounts.lottery.load()?.has_ended {
            return Err(error!(LotteryError::LotteryAlreadyEnded));
        }

        if ctx.accounts.lottery.load()?.close_slot > Clock::get()?.slot {
            return Err(error!(LotteryError::LotteryActive));
        }

        // TODO: verify winner bought a ticket OR is the lottery authority (if no entries)

        let lottery_authority = ctx.accounts.lottery.load()?.authority;
        let lottery_seeds = &[
            LOTTERY_SEED,
            lottery_authority.as_ref(),
            &[ctx.accounts.lottery.load()?.bump],
        ];

        // Close the Switchboard request account and its associated token wallet.
        // This will send all funds to the winner.
        let close_ctx = FunctionRequestClose {
            request: ctx.accounts.switchboard_request.to_account_info(),
            authority: ctx.accounts.lottery.to_account_info(),
            escrow: ctx.accounts.switchboard_request_escrow.to_account_info(),
            function: ctx.accounts.switchboard_function.to_account_info(),
            sol_dest: ctx.accounts.winner.to_account_info(),
            escrow_dest: ctx.accounts.escrow.to_account_info(),
            state: ctx.accounts.switchboard_state.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        close_ctx.invoke_signed(
            ctx.accounts.switchboard.clone(),
            Some(true),
            &[lottery_seeds],
        )?;

        anchor_spl::token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.escrow.to_account_info(),
                destination: ctx.accounts.winner.to_account_info(),
                authority: ctx.accounts.lottery.to_account_info(),
            },
            &[&[
                LOTTERY_SEED,
                ctx.accounts.lottery.load()?.authority.key().as_ref(),
                &[ctx.accounts.lottery.load()?.bump],
            ]],
        ))?;

        let mut lottery = ctx.accounts.lottery.load_mut()?;
        lottery.has_ended = true;
        lottery.winner = winner;

        emit!(LotteryWinnerSelected {
            lottery: ctx.accounts.lottery.key(),
            winner,
            jackpot: ctx.accounts.escrow.amount,
            settled_slot: Clock::get()?.slot,
            settled_timestamp: Clock::get()?.unix_timestamp,
        });

        Ok(())
    }
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

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    // PROGRAM ACCOUNTS
    #[account(
        init,
        space = 8 + std::mem::size_of::<ProgramState>(),
        payer = payer,
        seeds = [PROGRAM_SEED],
        bump
    )]
    pub program_state: AccountLoader<'info, ProgramState>,
    /// CHECK: an account authorized to change the program config.
    pub authority: AccountInfo<'info>,

    // SWITCHBOARD ACCOUNTS
    #[account(
        constraint =
            // Ensure custom requests are allowed
            switchboard_function.load()?.requests_disabled == 0
    )]
    pub switchboard_function: AccountLoader<'info, FunctionAccountData>,

    // SYSTEM ACCOUNTS
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateLottery<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    // PROGRAM ACCOUNTS
    #[account(
        seeds = [PROGRAM_SEED],
        bump = program_state.load()?.bump,
        has_one = switchboard_function,
    )]
    pub program_state: AccountLoader<'info, ProgramState>,

    #[account(
        init,
        payer = payer,
        space = 8 + std::mem::size_of::<LotteryState>(),
        seeds = [LOTTERY_SEED, authority.key().as_ref()],
        bump
    )]
    pub lottery: AccountLoader<'info, LotteryState>,

    #[account(
        init,
        payer = payer,
        associated_token::mint = switchboard_mint,
        associated_token::authority = lottery,
    )]
    pub lottery_escrow: Account<'info, TokenAccount>,

    /// CHECK: an account authorized to change the lottery config.
    pub authority: AccountInfo<'info>,

    // SWITCHBOARD ACCOUNTS
    /// CHECK: program ID checked.
    #[account(executable, address = SWITCHBOARD_ATTESTATION_PROGRAM_ID)]
    pub switchboard: AccountInfo<'info>,
    #[account(address = anchor_spl::token::spl_token::native_mint::ID)]
    pub switchboard_mint: Account<'info, Mint>,
    /// CHECK:
    #[account(
        seeds = [STATE_SEED],
        seeds::program = switchboard.key(),
        bump = switchboard_state.load()?.bump,
      )]
    pub switchboard_state: AccountLoader<'info, AttestationProgramState>,
    pub switchboard_attestation_queue: AccountLoader<'info, AttestationQueueAccountData>,
    #[account(
        mut,
        constraint =
            // Ensure custom requests are allowed
            switchboard_function.load()?.requests_disabled == 0
    )]
    pub switchboard_function: AccountLoader<'info, FunctionAccountData>,
    // The Switchboard Function Request account we will create with a CPI.
    // Should be an empty keypair with no lamports or data.
    /// CHECK:
    #[account(
        mut,
        signer,
        owner = system_program.key(),
        constraint = switchboard_request.data_len() == 0 && switchboard_request.lamports() == 0
      )]
    pub switchboard_request: AccountInfo<'info>,
    /// CHECK:
    #[account(
        mut,
        owner = system_program.key(),
        constraint = switchboard_request_escrow.data_len() == 0 && switchboard_request_escrow.lamports() == 0
      )]
    pub switchboard_request_escrow: AccountInfo<'info>,

    // SYSTEM ACCOUNTS
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

#[derive(Accounts)]
pub struct BuyTicket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        has_one = escrow,
    )]
    pub lottery: AccountLoader<'info, LotteryState>,

    pub escrow: Box<Account<'info, TokenAccount>>,

    // SYSTEM ACCOUNTS
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct DrawWinner<'info> {
    #[account(
        mut,
        has_one = switchboard_request,
    )]
    pub lottery: AccountLoader<'info, LotteryState>,

    #[account(mut)]
    pub escrow: Box<Account<'info, TokenAccount>>,

    /// CHECK: we should validate this is owned by the SystemProgram
    #[account(mut)]
    pub winner: AccountInfo<'info>,

    // SWITCHBOARD ACCOUNTS
    /// CHECK: program ID checked.
    #[account(executable, address = SWITCHBOARD_ATTESTATION_PROGRAM_ID)]
    pub switchboard: AccountInfo<'info>,
    #[account(
        seeds = [STATE_SEED],
        seeds::program = switchboard.key(),
        bump = switchboard_state.load()?.bump,
      )]
    pub switchboard_state: AccountLoader<'info, AttestationProgramState>,
    pub switchboard_function: AccountLoader<'info, FunctionAccountData>,
    #[account(
        mut,
        constraint = switchboard_request.validate_signer(
            &switchboard_function,
            &enclave_signer.to_account_info()
            )?
        )]
    pub switchboard_request: Box<Account<'info, FunctionRequestAccountData>>,
    pub enclave_signer: Signer<'info>,

    #[account(mut)]
    pub switchboard_request_escrow: Box<Account<'info, TokenAccount>>,

    // SYSTEM ACCOUNTS
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
#[derive(Eq, PartialEq)]
pub enum LotteryError {
    #[msg("Invalid authority account")]
    InvalidAuthority,
    #[msg("Lottery has ended")]
    LotteryAlreadyEnded,
    #[msg("Lottery tickets are sold out")]
    LotterySoldOut,
    #[msg("Lottery is active and cannot be closed")]
    LotteryActive,
}

#[event]
pub struct LotteryTicketPurchased {
    pub lottery: Pubkey,
    pub user: Pubkey,
    pub entry_fee: u64,
    pub num_tickets: u32,
}

#[event]
pub struct LotteryWinnerSelected {
    pub lottery: Pubkey,
    pub winner: Pubkey,
    pub jackpot: u64,
    pub settled_timestamp: i64,
    pub settled_slot: u64,
}
