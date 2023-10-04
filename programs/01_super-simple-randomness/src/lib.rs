#![allow(clippy::result_large_err)]
// Program: Solana Simple Randomness
// This Solana program will allow you to request a new random value for a given user.
// The following instructions are supported:
// - guess:       Submits a new guess for the current user. This will make a CPI to the
//                Switchboard Function Request account to trigger the off-chain docker container.
// - settle:      This ixn will be invoked by the Switchboard oracle off-chain and will provide
//                the random result to determine if the user won.

use switchboard_solana::prelude::*;

declare_id!("E5MAszjz8qZZDHKqQ21g5wYuhMTjMbk1L4L4jBFXMgqG");

pub const PROGRAM_SEED: &[u8] = b"SIMPLE_RANDOMNESS";
pub const USER_SEED: &[u8] = b"RANDOMNESS_USER";

// [MIN_RESULT, MAX_RESULT]
/// The minimum guess that can be submitted, inclusive.
pub const MIN_RESULT: u32 = 1;
/// The maximum guess that can be submitted, inclusive.
pub const MAX_RESULT: u32 = 10;

/// The minimum amount of time before a user can re-guess if the previous guess hasnt settled.
pub const REQUEST_TIMEOUT: i64 = 60;

/// Represents a users config.
/// PDA scheme enforces 1 user per authority.
#[account]
pub struct UserState {
    /// PDA bump seed.
    pub bump: u8,
    /// Account authorized to make config changes.
    pub authority: Pubkey,
    /// Switchboard Function Request pubkey.
    pub switchboard_request: Pubkey,
    /// The current users guess.
    pub guess: u32,
    /// The Switchboard Function result.
    pub result: u32,
    /// The timestamp when the current guess was placed.
    pub request_timestamp: i64,
    /// The timestamp when the request was settled.
    pub settled_timestamp: i64,
}

#[program]
pub mod super_simple_randomness {
    use super::*;

    pub fn guess(ctx: Context<Guess>, guess: u32) -> anchor_lang::Result<()> {
        if ctx.accounts.user.request_timestamp > 0
            && ctx.accounts.user.settled_timestamp == 0
            && Clock::get()?.unix_timestamp - ctx.accounts.user.request_timestamp < REQUEST_TIMEOUT
        {
            return Err(error!(SimpleRandomnessError::RequestNotReady));
        }

        // Initialize user account if needed
        if ctx.accounts.user.bump == 0 {
            ctx.accounts.user.bump = *ctx.bumps.get("user").unwrap();
            ctx.accounts.user.authority = ctx.accounts.authority.key();
        }

        // Set new guess data
        ctx.accounts.user.switchboard_request = ctx.accounts.switchboard_request.key();
        ctx.accounts.user.guess = guess;
        ctx.accounts.user.result = 0;
        ctx.accounts.user.request_timestamp = Clock::get()?.unix_timestamp;
        ctx.accounts.user.settled_timestamp = 0;

        // Trigger the Switchboard request
        // This will instruct the off-chain oracles to execute your docker container and relay
        // the result back to our program via the 'settle' instruction.

        let request_params = format!(
            "PID={},MIN_RESULT={},MAX_RESULT={},USER={}",
            crate::id(),
            MIN_RESULT,
            MAX_RESULT,
            ctx.accounts.user.key(),
        );

        // https://docs.rs/switchboard-solana/latest/switchboard_solana/attestation_program/instructions/request_init_and_trigger/index.html
        let request_init_ctx = FunctionRequestInitAndTrigger {
            request: ctx.accounts.switchboard_request.clone(),
            authority: ctx.accounts.user.to_account_info(),
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
        let user_authority_pubkey = ctx.accounts.authority.key();
        let seeds = &[
            USER_SEED,
            user_authority_pubkey.as_ref(),
            &[ctx.accounts.user.bump],
        ];

        request_init_ctx.invoke_signed(
            ctx.accounts.switchboard.clone(),
            // bounty - optional fee to reward oracles for priority processing
            // default: 0 lamports
            None,
            // slots_until_expiration - optional max number of slots the request can be processed in
            // default: 2250 slots, ~ 15 min at 400 ms/slot
            // minimum: 150 slots, ~ 1 min at 400 ms/slot
            None,
            // max_container_params_len - the length of the vec containing the container params
            // default: 256 bytes
            Some(512),
            // container_params - the container params
            // default: empty vec
            Some(request_params.into_bytes()),
            // garbage_collection_slot - the slot when the request can be closed by anyone and is considered dead
            // default: None, only authority can close the request
            None,
            // valid_after_slot - schedule a request to execute in N slots
            // default: 0 slots, valid immediately for oracles to process
            None,
            // signer seeds
            &[seeds],
        )?;

        Ok(())
    }

    pub fn settle(ctx: Context<Settle>, result: u32) -> anchor_lang::Result<()> {
        if !(MIN_RESULT..MAX_RESULT).contains(&result) {
            return Err(error!(SimpleRandomnessError::RandomResultOutOfBounds));
        }

        if ctx.accounts.user.settled_timestamp > 0 {
            return Err(error!(SimpleRandomnessError::RequestAlreadySettled));
        }

        ctx.accounts.user.result = result;
        ctx.accounts.user.settled_timestamp = Clock::get()?.unix_timestamp;

        // TODO: handle any custom game logic here

        emit!(UserGuessSettled {
            user: ctx.accounts.user.key(),
            user_guess: ctx.accounts.user.guess,
            result: ctx.accounts.user.result,
            user_won: ctx.accounts.user.result == ctx.accounts.user.guess,
            request_timestamp: ctx.accounts.user.request_timestamp,
            settled_timestamp: ctx.accounts.user.settled_timestamp
        });

        Ok(())
    }
}

#[event]
pub struct UserGuessSettled {
    pub user: Pubkey,
    pub user_guess: u32,
    pub result: u32,
    pub user_won: bool,
    pub request_timestamp: i64,
    pub settled_timestamp: i64,
}

#[derive(Accounts)]
pub struct Guess<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    // RANDOMNESS PROGRAM ACCOUNTS
    #[account(
        init_if_needed,
        space = 8 + std::mem::size_of::<UserState>(),
        payer = payer,
        seeds = [USER_SEED, authority.key().as_ref()],
        bump
    )]
    pub user: Account<'info, UserState>,

    /// CHECK:
    pub authority: AccountInfo<'info>,

    // SWITCHBOARD ACCOUNTS
    /// CHECK:
    #[account(executable, address = SWITCHBOARD_ATTESTATION_PROGRAM_ID)]
    pub switchboard: AccountInfo<'info>,
    /// CHECK: validated by Switchboard CPI
    pub switchboard_state: AccountLoader<'info, AttestationProgramState>,
    pub switchboard_attestation_queue: AccountLoader<'info, AttestationQueueAccountData>,
    /// CHECK: validated by Switchboard CPI
    #[account(mut)]
    pub switchboard_function: AccountLoader<'info, FunctionAccountData>,
    /// CHECK: validated by Switchboard CPI
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

    // TOKEN ACCOUNTS
    #[account(address = anchor_spl::token::spl_token::native_mint::ID)]
    pub switchboard_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    // SYSTEM ACCOUNTS
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    // RANDOMNESS PROGRAM ACCOUNTS
    #[account(
        mut,
        seeds = [USER_SEED, user.authority.as_ref()],
        bump = user.bump,
        has_one = switchboard_request,
    )]
    pub user: Account<'info, UserState>,

    // SWITCHBOARD ACCOUNTS
    pub switchboard_function: AccountLoader<'info, FunctionAccountData>,
    #[account(
    constraint = switchboard_request.validate_signer(
        &switchboard_function.to_account_info(),
        &enclave_signer.to_account_info()
        )?
    )]
    pub switchboard_request: Box<Account<'info, FunctionRequestAccountData>>,
    pub enclave_signer: Signer<'info>,
}

#[error_code]
#[derive(Eq, PartialEq)]
pub enum SimpleRandomnessError {
    #[msg("Invalid authority account")]
    InvalidAuthority,
    #[msg("Request not ready for a new guess")]
    RequestNotReady,
    #[msg("Request already settled")]
    RequestAlreadySettled,
    #[msg("Random result is out-of-bounds")]
    RandomResultOutOfBounds,
}
