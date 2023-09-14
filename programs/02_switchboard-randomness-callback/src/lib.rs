// Program: Solana Simple Randomness
// This Solana program will allow you to request a new random value for a given user.
// The following instructions are supported:
// - initialize:  Initializes the program state with our Switchboard Function pubkey. The
//                Switchboard Function points to our off-chain docker container and is
//                responsible for generating the random value and calling our settle ixn.
// - create_user: Creates a new user who is allowed to request a new random value. This will
//                create a new user owned Switchboard Function Request account with a CPI.
// - guess:       Submits a new guess for the current user. This will make a CPI to the
//                Switchboard Function Request account to trigger the off-chain docker container.
// - settle:      This ixn will be invoked by the Switchboard oracle off-chain and will provide
//                the random result to determine if the user won.
// - close:       This ixn will close the Switchboard Request account for the given user, the requests
//                escrow account, and the users randomness account. All SOL will be transferred to the
//                users authority account.

use switchboard_solana::prelude::*;

declare_id!("5bKuRru1qgEeQUXSAJvsXc8hZEGpCucEaaDQkmyd8j6v");

pub const PROGRAM_SEED: &[u8] = b"SIMPLE_RANDOMNESS";
pub const USER_SEED: &[u8] = b"RANDOMNESS_USER";

// [MIN_RESULT, MAX_RESULT]
/// The minimum guess that can be submitted, inclusive.
pub const MIN_RESULT: u32 = 1;
/// The maximum guess that can be submitted, inclusive.
pub const MAX_RESULT: u32 = 10;

/// The minimum amount of time before a user can re-guess if the previous guess hasnt settled.
pub const REQUEST_TIMEOUT: i64 = 60;

#[program]
pub mod switchboard_randomness_callback {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let mut program_state = ctx.accounts.program_state.load_init()?;

        program_state.bump = *ctx.bumps.get("program_state").unwrap();
        program_state.authority = *ctx.accounts.authority.key;
        program_state.switchboard_function = ctx.accounts.switchboard_function.key();

        Ok(())
    }

    pub fn create_user(ctx: Context<CreateUser>) -> Result<()> {
        // Verify this exists
        let _program_state = ctx.accounts.program_state.load()?;

        let user_key = ctx.accounts.user.key();

        // Create the Switchboard request account.
        let request_init_ctx = FunctionRequestInit {
            request: ctx.accounts.switchboard_request.clone(),
            authority: ctx.accounts.user.to_account_info(),
            function: ctx.accounts.switchboard_function.to_account_info(),
            function_authority: None, // only needed if switchboard_function.requests_require_authorization is enabled
            escrow: ctx.accounts.switchboard_request_escrow.clone(),
            mint: ctx.accounts.switchboard_mint.to_account_info(),
            state: ctx.accounts.switchboard_state.to_account_info(),
            attestation_queue: ctx.accounts.switchboard_attestation_queue.to_account_info(),
            payer: ctx.accounts.payer.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
        };
        let request_params = format!(
            "PID={},MIN_RESULT={},MAX_RESULT={},USER={}",
            crate::id(),
            MIN_RESULT,
            MAX_RESULT,
            user_key,
        );
        request_init_ctx.invoke(
            ctx.accounts.switchboard.clone(),
            &FunctionRequestInitParams {
                // max_container_params_len - the length of the vec containing the container params
                // default: 256 bytes
                max_container_params_len: Some(512),
                // container_params - the container params
                // default: empty vec
                container_params: request_params.into_bytes(),
                // garbage_collection_slot - the slot when the request can be closed by anyone and is considered dead
                // default: None, only authority can close the request
                garbage_collection_slot: None,
            },
        )?;

        let mut user = ctx.accounts.user.load_init()?;
        user.bump = *ctx.bumps.get("user").unwrap();
        user.authority = ctx.accounts.authority.key();
        user.switchboard_request = ctx.accounts.switchboard_request.key();

        Ok(())
    }

    pub fn guess(ctx: Context<Guess>, guess: u32) -> Result<()> {
        if ctx.accounts.user.load()?.request_timestamp > 0
            && ctx.accounts.user.load()?.settled_timestamp == 0
            && Clock::get()?.unix_timestamp - ctx.accounts.user.load()?.request_timestamp
                < REQUEST_TIMEOUT
        {
            return Err(error!(SimpleRandomnessError::RequestNotReady));
        }

        // NOTE: See FunctionRequestInitAndTrigger to create a new request each time and trigger it.
        // https://docs.rs/switchboard-solana/latest/switchboard_solana/attestation_program/instructions/request_init_and_trigger/index.html

        // Trigger the Switchboard request
        // This will instruct the off-chain oracles to execute your docker container and relay
        // the result back to our program via the 'settle' instruction.
        let request_trigger_ctx = FunctionRequestTrigger {
            request: ctx.accounts.switchboard_request.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
            escrow: ctx.accounts.switchboard_request_escrow.to_account_info(),
            function: ctx.accounts.switchboard_function.to_account_info(),
            state: ctx.accounts.switchboard_state.to_account_info(),
            attestation_queue: ctx.accounts.switchboard_attestation_queue.to_account_info(),
            payer: ctx.accounts.payer.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        };

        let user_authority_pubkey = ctx.accounts.authority.key();
        let seeds = &[
            USER_SEED,
            user_authority_pubkey.as_ref(),
            &[ctx.accounts.user.load()?.bump],
        ];

        request_trigger_ctx.invoke_signed(
            ctx.accounts.switchboard.clone(),
            // bounty - optional fee to reward oracles for priority processing
            // default: 0 lamports
            None,
            // slots_until_expiration - optional max number of slots the request can be processed in
            // default: 2250 slots, ~ 15 min at 400 ms/slot
            // minimum: 150 slots, ~ 1 min at 400 ms/slot
            None,
            // valid_after_slot - schedule a request to execute in N slots
            // default: 0 slots, valid immediately for oracles to process
            None,
            &[seeds],
        )?;

        let mut user = ctx.accounts.user.load_mut()?;

        // Set new guess data
        user.guess = guess;
        user.result = 0;
        user.request_timestamp = Clock::get()?.unix_timestamp;
        user.settled_timestamp = 0;

        Ok(())
    }

    pub fn settle(ctx: Context<Settle>, result: u32) -> Result<()> {
        if !(MIN_RESULT..MAX_RESULT).contains(&result) {
            return Err(error!(SimpleRandomnessError::RandomResultOutOfBounds));
        }

        let mut user = ctx.accounts.user.load_mut()?;
        if user.settled_timestamp > 0 {
            return Err(error!(SimpleRandomnessError::RequestAlreadySettled));
        }

        user.result = result;
        user.settled_timestamp = Clock::get()?.unix_timestamp;

        // TODO: handle any custom game logic here

        emit!(UserGuessSettled {
            user: ctx.accounts.user.key(),
            user_won: user.result == user.guess,
            request_timestamp: user.request_timestamp,
            settled_timestamp: user.settled_timestamp
        });

        Ok(())
    }

    pub fn close(ctx: Context<Close>) -> Result<()> {
        let user_bump = ctx.accounts.user.load()?.bump;

        // Close the Switchboard request account and its associated token wallet.
        let close_ctx = FunctionRequestClose {
            request: ctx.accounts.switchboard_request.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
            escrow: ctx.accounts.switchboard_request_escrow.to_account_info(),
            function: ctx.accounts.switchboard_function.to_account_info(),
            sol_dest: ctx.accounts.authority.to_account_info(),
            escrow_dest: ctx.accounts.escrow_dest.to_account_info(),
            state: ctx.accounts.switchboard_state.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        close_ctx.invoke_signed(
            ctx.accounts.switchboard.clone(),
            &[&[
                USER_SEED,
                ctx.accounts.authority.key().as_ref(),
                &[user_bump],
            ]],
        )?;

        // Anchor will handle closing our program accounts because we used the 'close' attribute.

        Ok(())
    }
}

#[event]
pub struct UserGuessSettled {
    pub user: Pubkey,
    pub user_won: bool,
    pub request_timestamp: i64,
    pub settled_timestamp: i64,
}

/// Represents the global state of the program.
#[account(zero_copy(unsafe))]
pub struct ProgramState {
    /// PDA bump seed.
    pub bump: u8,
    /// Account authorized to make config changes.
    pub authority: Pubkey,
    /// Switchboard Function pubkey.
    pub switchboard_function: Pubkey,
}

/// Represents a users config.
/// PDA scheme enforces 1 user per authority.
#[account(zero_copy(unsafe))]
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
            // Ensure our authority owns this function
            // switchboard_function.load()?.authority == *authority.key &&
            // Ensure custom requests are allowed
            !switchboard_function.load()?.requests_disabled
    )]
    pub switchboard_function: AccountLoader<'info, FunctionAccountData>,

    // SYSTEM ACCOUNTS
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateUser<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    // RANDOMNESS PROGRAM ACCOUNTS
    #[account(
        seeds = [PROGRAM_SEED],
        bump = program_state.load()?.bump,
        has_one = switchboard_function
    )]
    pub program_state: AccountLoader<'info, ProgramState>,

    #[account(
        init,
        space = 8 + std::mem::size_of::<UserState>(),
        payer = payer,
        seeds = [USER_SEED, authority.key().as_ref()],
        bump
    )]
    pub user: AccountLoader<'info, UserState>,
    /// CHECK: the user's authority must sign to create a new user
    pub authority: AccountInfo<'info>,

    // SWITCHBOARD ACCOUNTS
    /// CHECK: program ID checked.
    #[account(executable, address = SWITCHBOARD_ATTESTATION_PROGRAM_ID)]
    pub switchboard: AccountInfo<'info>,
    /// CHECK:
    #[account(
        seeds = [STATE_SEED],
        seeds::program = switchboard.key(),
        bump = switchboard_state.load()?.bump,
      )]
    pub switchboard_state: AccountLoader<'info, AttestationProgramState>,
    pub switchboard_attestation_queue: AccountLoader<'info, AttestationQueueAccountData>,
    #[account(mut)]
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

    // TOKEN ACCOUNTS
    #[account(address = anchor_spl::token::spl_token::native_mint::ID)]
    pub switchboard_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    // SYSTEM ACCOUNTS
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Guess<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    // RANDOMNESS PROGRAM ACCOUNTS
    #[account(
        mut,
        seeds = [USER_SEED, authority.key().as_ref()],
        bump = user.load()?.bump,
        has_one = switchboard_request,
        has_one = authority,
    )]
    pub user: AccountLoader<'info, UserState>,

    /// CHECK: the user's authority must sign to guess on their behalf
    pub authority: Signer<'info>,

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
    #[account(mut)]
    pub switchboard_request: Box<Account<'info, FunctionRequestAccountData>>,
    /// CHECK: validated by Switchboard CPI
    #[account(mut)]
    pub switchboard_request_escrow: AccountInfo<'info>,

    // TOKEN ACCOUNTS
    pub token_program: Program<'info, Token>,

    // SYSTEM ACCOUNTS
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    // RANDOMNESS PROGRAM ACCOUNTS
    #[account(
        mut,
        has_one = switchboard_request,
    )]
    pub user: AccountLoader<'info, UserState>,

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

#[derive(Accounts)]
pub struct Close<'info> {
    // RANDOMNESS PROGRAM ACCOUNTS
    #[account(
        mut,
        close = authority,
        has_one = switchboard_request,
        has_one = authority,
    )]
    pub user: AccountLoader<'info, UserState>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub escrow_dest: Box<Account<'info, TokenAccount>>,

    // SWITCHBOARD ACCOUNTS
    /// CHECK:
    #[account(executable, address = SWITCHBOARD_ATTESTATION_PROGRAM_ID)]
    pub switchboard: AccountInfo<'info>,
    pub switchboard_state: AccountLoader<'info, AttestationProgramState>,
    /// CHECK: validated by Switchboard CPI
    #[account(mut)]
    pub switchboard_function: AccountLoader<'info, FunctionAccountData>,
    /// CHECK: validated by Switchboard CPI
    #[account(mut)]
    pub switchboard_request: Box<Account<'info, FunctionRequestAccountData>>,
    /// CHECK: validated by Switchboard CPI
    #[account(mut)]
    pub switchboard_request_escrow: Box<Account<'info, TokenAccount>>,
    #[account(address = anchor_spl::token::spl_token::native_mint::ID)]
    pub switchboard_mint: Account<'info, Mint>,

    // TOKEN ACCOUNTS
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    // SYSTEM ACCOUNTS
    pub system_program: Program<'info, System>,
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
