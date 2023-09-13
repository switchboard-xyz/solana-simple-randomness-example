import {
  AttestationQueueAccount,
  DEVNET_GENESIS_HASH,
  FunctionAccount,
  FunctionRequestAccount,
  MAINNET_GENESIS_HASH,
  SwitchboardProgram,
  attestationTypes,
  loadKeypair,
} from "@switchboard-xyz/solana.js";
import * as anchor from "@coral-xyz/anchor";
import { SuperSimpleRandomness } from "../target/types/super_simple_randomness";
import {
  jsonReplacers,
  parseRawMrEnclave,
  promiseWithTimeout,
} from "@switchboard-xyz/common";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";
import { addMrEnclave, loadSwitchboardFunctionEnv, myMrEnclave } from "./utils";
dotenv.config();

interface UserGuessSettledEvent {
  user: anchor.web3.PublicKey;
  userWon: boolean;
  requestTimestamp: anchor.BN;
  settledTimestamp: anchor.BN;
}

interface CostReceipt {
  name: string;
  description?: string;
  cost: number;
}

(async () => {
  if (!myMrEnclave) {
    throw new Error(
      `You need a ./measurement.txt in the project root or define MR_ENCLAVE in your .env file`
    );
  }
  console.log(
    `\n${chalk.green(
      "This script will invoke our Super Simple Randomness program and request a random value between 1 and 10. If SWITCHBOARD_FUNCTION_PUBKEY is not present in your .env file then a new Switchboard Function will be created each time. A Switchboard Request is an instance of a function and allows us to pass custom parameters. In this example we create a new request each time - this is wasteful and requires the user to manually close these after use. See the Switchboard Randomness Callback example program for a more complete implementation where each user has a dedicated request account."
    )}`
  );

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(
    process.argv.length > 2
      ? new anchor.AnchorProvider(
          provider.connection,
          new anchor.Wallet(loadKeypair(process.argv[2])),
          {}
        )
      : provider
  );

  const program: anchor.Program<SuperSimpleRandomness> =
    anchor.workspace.SuperSimpleRandomness;

  const payer = (provider.wallet as anchor.Wallet).payer;
  console.log(`[env] PAYER: ${payer.publicKey}`);

  const costReceipts: CostReceipt[] = [];

  const startingPayerBalance = await program.provider.connection.getBalance(
    payer.publicKey
  );

  const switchboardProgram = await SwitchboardProgram.fromProvider(provider);

  let switchboardFunction: FunctionAccount | undefined = undefined;
  let functionState: attestationTypes.FunctionAccountData | undefined =
    undefined;

  let attestationQueue: AttestationQueueAccount | undefined = undefined;

  [switchboardFunction, functionState] = await loadSwitchboardFunctionEnv(
    switchboardProgram
  );

  // If we loaded our function from .env, try to add the measurement.txt to our function config
  if (switchboardFunction) {
    attestationQueue = new AttestationQueueAccount(
      switchboardProgram,
      functionState.attestationQueue
    );

    const addEnclaveTxn = await addMrEnclave(
      switchboardProgram,
      switchboardFunction,
      functionState
    );

    if (addEnclaveTxn) {
      costReceipts.push({
        name: "function_set_config",
        description:
          "transaction fee to add the MrEnclave to our function's config",
        cost: 5000 / anchor.web3.LAMPORTS_PER_SOL,
      });
    }
  } else {
    if (!process.env.DOCKERHUB_IMAGE_NAME) {
      throw new Error(
        `You need to set DOCKERHUB_IMAGE_NAME in your .env file to create a new Switchboard Function. Example:\n\tDOCKERHUB_IMAGE_NAME=gallynaut/solana-simple-randomness-function`
      );
    }

    // Get the Attestation queue address from the clusters genesis hash
    const genesisHash = await provider.connection.getGenesisHash();
    const attestationQueueAddress =
      genesisHash === MAINNET_GENESIS_HASH
        ? "2ie3JZfKcvsRLsJaP5fSo43gUo1vsurnUAtAgUdUAiDG"
        : genesisHash === DEVNET_GENESIS_HASH
        ? "CkvizjVnm2zA5Wuwan34NhVT3zFc7vqUyGnA6tuEF5aE"
        : undefined;
    if (!attestationQueueAddress) {
      throw new Error(
        `The request script currently only works on mainnet-beta or devnet (if SWITCHBOARD_FUNCTION_PUBKEY is not set in your .env file))`
      );
    }

    attestationQueue = new AttestationQueueAccount(
      switchboardProgram,
      attestationQueueAddress
    );

    console.log(`Initializing new SwitchboardFunction ...`);
    let functionInitTx: string;

    [switchboardFunction, functionInitTx] = await FunctionAccount.create(
      switchboardProgram,
      {
        name: "SIMPLE-RANDOMNESS",
        metadata:
          "https://github.com/switchboard-xyz/solana-simple-randomness-example/tree/main/switchboard-function",
        container: process.env.DOCKERHUB_IMAGE_NAME,
        containerRegistry: "dockerhub",
        version: "latest",
        attestationQueue,
        authority: payer.publicKey,
        mrEnclave: myMrEnclave,
      }
    );

    console.log(
      `\nMake sure to add the following to your .env file:\n\tSWITCHBOARD_FUNCTION_PUBKEY=${switchboardFunction.publicKey}\n\n`
    );

    // Log the txn signatures and add the cost receipts for easier debugging
    console.log(`[TX] function_init: ${functionInitTx}`);
    costReceipts.push({
      name: "FunctionAccount - rent",
      description: "Rent exemption for the Switchboard FunctionAccount",
      cost:
        (await program.provider.connection.getMinimumBalanceForRentExemption(
          switchboardProgram.attestationAccount.functionAccountData.size
        )) / anchor.web3.LAMPORTS_PER_SOL,
    });
    costReceipts.push({
      name: "function_init",
      description: "Transaction fee to create the function account",
      cost: 5000 / anchor.web3.LAMPORTS_PER_SOL,
    });
  }

  const attestationQueueState = await attestationQueue.loadData();

  /////////////////////////////////
  // SUPER SIMPLE RANDOMNESS   ////
  /////////////////////////////////
  const [userPubkey] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("RANDOMNESS_USER"), payer.publicKey.toBytes()],
    program.programId
  );
  console.log(`USER: ${userPubkey}`);
  const initialUserAccountInfo =
    await program.provider.connection.getAccountInfo(userPubkey);

  const switchboardRequestKeypair = anchor.web3.Keypair.generate();
  const switchboardRequestEscrowPubkey = anchor.utils.token.associatedAddress({
    mint: switchboardProgram.mint.address,
    owner: switchboardRequestKeypair.publicKey,
  });

  const switchboardRequest = new FunctionRequestAccount(
    switchboardProgram,
    switchboardRequestKeypair.publicKey
  );

  // CREATE AND TRIGGER THE REQUEST
  const requestStartTime = Date.now();
  let listener = null;
  let betTx = "";
  const [event, slot] = (await promiseWithTimeout(
    45_000,
    new Promise(async (resolve, _reject) => {
      listener = program.addEventListener("UserGuessSettled", (event, slot) => {
        resolve([event, slot]);
      });
      program.methods
        .guess(1)
        .accounts({
          payer: payer.publicKey,
          user: userPubkey,
          authority: payer.publicKey,
          switchboard: switchboardProgram.attestationProgramId,
          switchboardState:
            switchboardProgram.attestationProgramState.publicKey,
          switchboardAttestationQueue: attestationQueue.publicKey,
          switchboardFunction: switchboardFunction.publicKey,
          switchboardRequest: switchboardRequest.publicKey,
          switchboardRequestEscrow: switchboardRequestEscrowPubkey,
          switchboardMint: switchboardProgram.mint.address,
        })
        .signers([switchboardRequestKeypair])
        .rpc()
        .then(async (tx) => {
          console.log(`[TX] guess: ${tx}\n`);
          betTx = tx;
        });
    }),
    "Timed out waiting for 'UserGuessSettled' event"
  ).catch(async (err) => {
    const userState = await program.account.userState.fetch(
      userPubkey,
      "processed"
    );
    console.log(userState, jsonReplacers, 2);
    if (listener) {
      await program.removeEventListener(listener).then(() => {
        listener = null;
      });
    }
    throw err;
  })) as unknown as [UserGuessSettledEvent, number];

  const requestPostTxnTime = Date.now();
  let requestSettleTime = requestPostTxnTime;

  await program.removeEventListener(listener).then(() => {
    listener = null;
  });

  if (event.userWon) {
    console.log(`You won!`);
  } else {
    console.log(`Sorry, you lost!`);
  }

  costReceipts.push({
    name: "Switchboard Fee",
    description:
      "Switchboard fee for the request to reward oracles for executing your function request",
    cost: attestationQueueState.reward / anchor.web3.LAMPORTS_PER_SOL,
  });

  console.log(`\n### METRICS`);

  const fullDuration = (requestSettleTime - requestStartTime) / 1000;
  console.log(`Settlement Time: ${fullDuration.toFixed(3)} seconds`);

  ////////////////////////////////////////////////////////////////
  // COST ESTIMATIONS
  ////////////////////////////////////////////////////////////////
  console.log(`\n### COST`);
  costReceipts.push({
    name: "guess",
    description: "transaction fee to make a guess",
    cost: 5000 / anchor.web3.LAMPORTS_PER_SOL,
  });
  if (!initialUserAccountInfo) {
    costReceipts.push({
      name: "UserState - rent",
      description:
        "Rent exemption for the randomness program's UserState account",
      cost:
        (await program.provider.connection.getMinimumBalanceForRentExemption(
          program.account.userState.size
        )) / anchor.web3.LAMPORTS_PER_SOL,
    });
  } else {
    console.log(
      `[info] UserState already exists for this user - init_if_needed was not triggered`
    );
  }

  costReceipts.push({
    name: "FunctionRequest - rent",
    description: "Rent exemption for the Switchboard FunctionRequestAccount",
    cost:
      (await program.provider.connection.getMinimumBalanceForRentExemption(
        await program.provider.connection
          .getAccountInfo(switchboardRequest.publicKey)
          .then((a) => a?.data.length)
          .catch(
            () =>
              switchboardProgram.attestationAccount.functionRequestAccountData
                .size + 512
          )
      )) / anchor.web3.LAMPORTS_PER_SOL,
  });

  costReceipts.push({
    name: "FunctionRequest Escrow - rent",
    description: "Wrapped SOL token account used to pay for requests",
    cost:
      (await program.provider.connection.getMinimumBalanceForRentExemption(
        await program.provider.connection
          .getAccountInfo(switchboardRequestEscrowPubkey)
          .then((a) => a?.data.length)
          .catch(() => 165 /** Token account bytes */)
      )) / anchor.web3.LAMPORTS_PER_SOL,
  });

  const switchboardFunctionCost = attestationQueueState.reward;

  // The Switchboard Request Account contains a Vec<u8> for the params. When initializing this account
  // we default to storing 512 bytes if not provided. You can decrease this value in
  // programs/super-simple-randomness/src/lib.rs, as seen belo
  //  request_init_ctx.invoke(
  //   ctx.accounts.switchboard.clone(),
  //   None,
  //   Some(1000), // slots_until_expiration
  //   Some(512), <--- here
  //   Some(request_params.into_bytes()),
  //   None,
  //   None,
  //   )?;
  const switchboardRequestAccountInfo =
    await program.provider.connection.getAccountInfo(
      switchboardRequest.publicKey
    );
  const switchboardRequestAccountCost =
    await program.provider.connection.getMinimumBalanceForRentExemption(
      switchboardRequestAccountInfo.data.length
    );

  const payerBalanceDelta =
    (startingPayerBalance -
      (await program.provider.connection.getBalance(payer.publicKey))) /
    anchor.web3.LAMPORTS_PER_SOL;

  console.log(
    `Payer Balance \u0394: ${chalk.red(`- ${payerBalanceDelta}`)} SOL`
  );
  console.log(
    `Switchboard Fee: ${
      switchboardFunctionCost / anchor.web3.LAMPORTS_PER_SOL
    } SOL (per request)`
  );
  console.log(
    `Request Account Rent: ${
      switchboardRequestAccountCost / anchor.web3.LAMPORTS_PER_SOL
    } SOL (per account)`
  );
  console.log(
    `\t${chalk.blue("NOTE: Request accounts can be closed after use.")}`
  );

  console.table(costReceipts);
})();
