import {
  AttestationQueueAccount,
  DEVNET_GENESIS_HASH,
  FunctionAccount,
  FunctionRequestAccount,
  MAINNET_GENESIS_HASH,
  SwitchboardProgram,
  attestationTypes,
  loadKeypair,
  types,
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
dotenv.config();

interface UserGuessSettledEvent {
  user: anchor.web3.PublicKey;
  userWon: boolean;
  requestTimestamp: anchor.BN;
  settledTimestamp: anchor.BN;
}

const MrEnclave: Uint8Array | undefined = process.env.MR_ENCLAVE
  ? parseRawMrEnclave(process.env.MR_ENCLAVE)
  : fs.existsSync(path.join(__dirname, "..", "measurement.txt"))
  ? parseRawMrEnclave(
      fs
        .readFileSync(path.join(__dirname, "..", "measurement.txt"), "utf-8")
        .trim()
    )
  : undefined;

(async () => {
  if (!MrEnclave) {
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
  const payer = (provider.wallet as anchor.Wallet).payer;
  console.log(`[env] PAYER: ${payer.publicKey}`);

  const program: anchor.Program<SuperSimpleRandomness> =
    anchor.workspace.SuperSimpleRandomness;

  const switchboardProgram = await SwitchboardProgram.fromProvider(provider);

  // verify House is created and load Switchboard Function
  let switchboardFunction: FunctionAccount;
  let attestationQueue: AttestationQueueAccount;
  // let attestationQueuePubkey: anchor.web3.PublicKey;
  let isFunctionAuthority: boolean | undefined = undefined;

  // Attempt to load from env file
  if (process.env.SWITCHBOARD_FUNCTION_PUBKEY) {
    console.log(
      `[env] SWITCHBOARD_FUNCTION_PUBKEY: ${process.env.SWITCHBOARD_FUNCTION_PUBKEY}`
    );
    const functionAccountInfo =
      await program.provider.connection.getAccountInfo(
        new anchor.web3.PublicKey(process.env.SWITCHBOARD_FUNCTION_PUBKEY)
      );

    if (!functionAccountInfo) {
      console.error(
        `$SWITCHBOARD_FUNCTION_PUBKEY in your .env file is incorrect, please fix. Creating a new Switchboard Function ...`
      );
    } else {
      // Lets attempt to load the Switchboard Function from our .env file
      let functionState: attestationTypes.FunctionAccountData;

      [switchboardFunction, functionState] = await FunctionAccount.load(
        switchboardProgram,
        process.env.SWITCHBOARD_FUNCTION_PUBKEY
      );

      attestationQueue = new AttestationQueueAccount(
        switchboardProgram,
        functionState.attestationQueue
      );
      isFunctionAuthority = functionState.authority.equals(payer.publicKey);

      if (!functionState.mrEnclaves.includes(Array.from(MrEnclave))) {
        // Make sure we can add this enclave or else it will fail to verify on-chain
        if (!isFunctionAuthority) {
          throw new Error(
            `Function is missing the MrEnclave value ${MrEnclave}. Attempted to add this to the Function config automatically but you are not the function authority (${functionState.authority}). Try creating your own Switchboard Function with '${payer.publicKey}' as the authority, then set SWITCHBOARD_FUNCTION_PUBKEY in your .env file.`
          );
        }

        let existingMeasurements = functionState.mrEnclaves.filter(
          (arr) => !arr.every((num) => num === 0)
        );
        if (existingMeasurements.length >= 32) {
          existingMeasurements = existingMeasurements.slice(
            existingMeasurements.length - 32 + 1
          );
        }

        // add to enclave
        const fnSetConfigTx = await switchboardFunction.setConfig({
          mrEnclaves: [...existingMeasurements, Array.from(MrEnclave)],
        });
        console.log(`[TX] function_set_config: ${fnSetConfigTx}`);
      }
    }
  }

  if (!switchboardFunction) {
    if (!process.env.DOCKERHUB_IMAGE_NAME) {
      throw new Error(
        `You need to set DOCKERHUB_IMAGE_NAME in your .env file to create a new Switchboard Function. Example:\n\tDOCKERHUB_IMAGE_NAME=gallynaut/solana-simple-randomness-function`
      );
    }
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
    await attestationQueue.loadData();

    console.log(`Initializing new SwitchboardFunction ...`);
    const [functionAccount, functionInitTx] = await FunctionAccount.create(
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
        mrEnclave: MrEnclave,
      }
    );
    console.log(`[TX] function_init: ${functionInitTx}`);

    console.log(
      `\nMake sure to add the following to your .env file:\n\tSWITCHBOARD_FUNCTION_PUBKEY=${functionAccount.publicKey}\n\n`
    );

    switchboardFunction = functionAccount;
  }

  /////////////////////////////////
  // SUPER SIMPLE RANDOMNESS   ////
  /////////////////////////////////
  const [userPubkey] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("RANDOMNESS_USER"), payer.publicKey.toBytes()],
    program.programId
  );
  console.log(`USER: ${userPubkey}`);

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
        .then((tx) => {
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

  // const userState = await program.account.userState.fetch(userPubkey);

  console.log(`\n### METRICS`);

  const fullDuration = (requestSettleTime - requestStartTime) / 1000;
  console.log(`Settlement Time: ${fullDuration.toFixed(3)} seconds`);

  console.log(`\n### COST`);
  const attestationQueueState = await attestationQueue.loadData();
  const switchboardFunctionCost = attestationQueueState.reward;
  const switchboardRequestAccountCost =
    await program.provider.connection.getMinimumBalanceForRentExemption(
      switchboardProgram.attestationAccount.functionRequestAccountData.size
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
})();
