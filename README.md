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
determine which instruction on your program to respond with.

**NOTE:** Scheduled and periodic calls are also supported but out of scope for
this example.

In this example when a user makes a guess, we will trigger a Switchboard
Function with our PROGRAM_ID, MIN_RESULT, MAX_RESULT, and the requesters
USER_KEY. With this information we can generate randomness within the enclave
and determine the result.

In both examples we will use the same `settle` instruction so we can re-use the
same function for both contracts (because we pass PROGRAM_ID as a param when we
create our requests). The code below shows the anchor logic within each program
for defining the `settle` instruction, along with the Switchboard Function logic
to generate a u32 result between [MIN_RESULT, MAX_RESULT] and build a partially
signed transaction with our settle instruction.

Switchboard oracles will read the emitted partially signed transaction, verify
the code was executed within a Trusted Execution Environment (TEE), and relay
the transaction on-chain. Switchboard oracles read a generated "quote" from the
codes runtime when you emit the partially signed transaction from your
container. This code is unique to the generated executable and relevant OS
files - any time you change the code or a dependency, your quote will change and
you will need to update your Switchboard Function config. These quotes are known
as `MrEnclaves` and represent a fingerprint of the code and the runtime. Within
your Switchboard Function you define a whitelist of MrEnclaves that are allowed
to perform some action on your contracts behalf. \*\*!! Make sure you validate
the Switchboard accounts, as seen below with:\*\*
`switchboard_request.validate_signer()`

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
    // RANDOMNESS PROGRAM ACCOUNTS
    #[account(
        mut,
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

//////////////////////////////////////////////////////
// SWITCHBOARD FUNCTION INSTRUCTION BUILDING LOGIC
//////////////////////////////////////////////////////
// Generate our random result
let random_result: u32 = generate_randomness(params.min_result, params.max_result);
let mut random_bytes = random_result.to_le_bytes().to_vec();

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
echo 'DOCKER_IMAGE_NAME=gallynaut/solana-simple-randomness-function' > .env
```

## Super Simple Randomness

The first example
[programs/super-simple-randomness](./programs/super-simple-randomness/src/lib.rs)
is a program with two instructions:

- **settle**: As mentioned in the
  [Switchboard Functions](#switchboard-functions) section above, this is the
  instruction our docker container will build and emit for the Switchboard
  oracles to verify and relay on-chain. Within this instruction you can perform
  any custom logic.

- **guess**: We use `init_if_needed` to initialize a UserState to store the
  guess and eventual result. Then perform a Cross Program Invocation (CPI) into
  the Switchboard program to create a new request and trigger it. This will
  instruct the off-chain oracles to run your container and verify it was
  executed within a trusted enclave.

```rust
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
    function: ctx.accounts.switchboard_function.to_account_info(),
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
    None,
    Some(1000),
    Some(512),
    Some(request_params.into_bytes()),
    None,
    None,
)?;
```

**NOTE:** This example uses anchors `init-if-needed` feature to create a new
account if it doesnt already exist. This feature should be avoided if possible
and is shown for demo purposes.

### Usage

Set the anchor program IDs to your local keypairs so you can deploy this
yourself:

```bash
anchor keys sync
```

Then deploy the contract with:

```bash
make simple-flip-deploy
# OR
anchor build -p super_simple_randomness
anchor deploy --provider.cluster devnet -p super_simple_randomness
```

Then submit a guess and await the result!

```bash
make simple-flip
# OR
anchor run simple-flip
```

### Testing Locally
You should always test your function flows locally to easily view your logs and confirm expected workflows.  To test locally, run

```bash
cd switchboard-function
sb solana function test --parameters "PID=${PID?},USER=${USER?},MAX_RESULT=10,MIN_RESULT=1"
```


## Switchboard Randomness Callback

The second example
[programs/switchboard-randomness-callback](./programs/switchboard-randomness-callback/src/lib.rs)
is a bit more complicated and shows a more efficient approach. In the
super-simple-randomness program we are creating a new Switchboard
FunctionRequestAccount each time we call the guess instruction. This means the
user is paying money for rent exemption on an account they will only use once -
Switchboard allows the authority of this account to close it but its not a good
design and requires the user to manually call another transaction to get their
rent back.

Another pitfall is we never verify the Switchboard FunctionAccount. This account
tells the off-chain oracles which container to run so a user could provide their
own function which always settles to their winning result. **You should always
verify either the Function or FunctionRequest account corresponds to some
expected pubkey/container.** Remember, validating accounts is the biggest
responsibility when developing on Solana - make sure you "Anchor" your accounts
to some expected bounds to prevent a malicous actor from mocking your layout
with incorrect data and passing it to your program.

So the changes we'll make will include:

- **Add `initialize` ixn**: Add a new instruction to initialize a global program
  state account for our program and store our function pubkey. When a user makes
  a request we will verify the request is created for this function each time.
- **Add `user_init` ixn**: Our user will need to run `user_init` before
  interacting with our program. This will setup the Switchboard FunctionRequest
  account with their params. When the user makes a guess we will trigger this
  account. Now our program is more efficient with managing rent exemption.

**MORE DOCS COMING SOON!**
