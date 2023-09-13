# Solana Simple Randomness

This repo shows two differnt methods to use Switchboard Functions to request and
consume randomness in your Solana programs.

For each example, we start by defining our Switchboard Function account - this
account defines the code we will execute off-chain to fulfill our randomness
request. Our off-chain code will call our contract and return a random value
bounded by a `MIN_VALUE` and `MAX_VALUE`.

## Switchboard Functions

We'll be working backwards a bit. Switchboard Functions allow you to
**_"callback"_** into your program with some arbitrary instruction. This means
within your function you can make network calls to off-chain resources and
determine which instruction on your program to respond with. In this example
when a user makes a guess, we will trigger a Switchboard Function with our
PROGRAM_ID, MIN_GUESS, MAX_GUESS, and the requesters USER_KEY. With this
information we can generate randomness within the enclave and determine the
result based on the users guess.

In both examples we will use the same `settle` instruction so we can re-use the
same function for both contracts (because we pass PROGRAM_ID as a param when we
create our requests). The code below shows the anchor logic within each program
for defining the `settle` instruction and the accounts context, along with the
Switchboard Function logic to generate a u32 result between [MIN_GUESS,
MAX_GUESS] and call the `settle` function in our program.



```rust
///////////////////////////
// ANCHOR CONTEXT
///////////////////////////
#[program]
pub mod switchboard_randomness_callback {
    use super::*;

    pub fn settle(ctx: Context<Settle>, result: u32) -> Result<()> {
        // ...
    }
}

#[derive(Accounts)]
pub struct Settle<'info> {
    // PROGRAM ACCOUNTS
    #[account(mut)]
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

//////////////////////////////////////////////////////
// SWITCHBOARD FUNCTION INSTRUCTION BUILDING LOGIC
//////////////////////////////////////////////////////
// IXN DATA:
// LEN: 12 bytes
// [0-8]: Anchor Ixn Discriminator
// [9-12]: Random Result as u32
let mut ixn_data = get_ixn_discriminator("settle").to_vec();
ixn_data.append(&mut random_bytes);

// 1. User (mut): our user who guessed
// 2. Switchboard Function
// 3. Switchboard Function Request
// 4. Enclave Signer (signer): our Gramine generated keypair
let settle_ixn = Instruction {
    program_id: params.program_id,
    data: ixn_data,
    accounts: vec![
        AccountMeta::new(params.user_key, false),
        AccountMeta::new_readonly(runner.function, false),
        AccountMeta::new_readonly(runner.function_request_key.unwrap(), false),
        AccountMeta::new_readonly(runner.signer, true),
    ],
};
```

## Optional, Publish Switchboard Function

Start by copying the env file to set your environment. To start you can use the
default container for your program. When you're ready, you can make changes to
the Switchboard Function and deploy to your own dockerhub organization.

```bash
echo 'DOCKERHUB_IMAGE_NAME=gallynaut/solana-simple-randomness-function' > .env
```

## Super Simple Randomness

The first example in
[programs/super-simple-randomness](./programs/super-simple-randomness/src/lib.rs)
shows a program with two instructions:

- **request_randomness**: This function accepts a Switchboard Function
