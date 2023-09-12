import {
  AttestationQueueAccount,
  DEVNET_GENESIS_HASH,
  FunctionAccount,
  FunctionRequestAccount,
  MAINNET_GENESIS_HASH,
  SwitchboardProgram,
  loadKeypair,
} from "@switchboard-xyz/solana.js";
import * as anchor from "@coral-xyz/anchor";
import { SolanaSimpleRandomness } from "../target/types/solana_simple_randomness";
import { parseRawMrEnclave, promiseWithTimeout } from "@switchboard-xyz/common";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

interface UserGuessSettledEvent {
  user: anchor.web3.PublicKey;
  userWon: boolean;
  requestTimestamp: anchor.BN;
  settledTimestamp: anchor.BN;
}

// const DOCKER_IMAGE_NAME =
//   process.env.DOCKER_IMAGE_NAME ?? "gallynaut/solana-vrf-flip";

const MrEnclave: Uint8Array | undefined = process.env.MR_ENCLAVE
  ? parseRawMrEnclave(process.env.MR_ENCLAVE)
  : fs.existsSync("measurement.txt")
  ? parseRawMrEnclave(fs.readFileSync("measurement.txt", "utf-8").trim())
  : undefined;

(async () => {
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
  console.log(`PAYER: ${payer.publicKey}`);

  const program: anchor.Program<SolanaSimpleRandomness> =
    anchor.workspace.SolanaSimpleRandomness;

  const switchboardProgram = await SwitchboardProgram.fromProvider(provider);

  const [programStatePubkey] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("SIMPLE_RANDOMNESS")],
    program.programId
  );
  console.log(`PROGRAM_STATE: ${programStatePubkey}`);

  // verify House is created and load Switchboard Function
  let switchboardFunction: FunctionAccount;
  let flipMintPubkey: anchor.web3.PublicKey;
  let houseVaultPubkey: anchor.web3.PublicKey;
  let attestationQueuePubkey: anchor.web3.PublicKey;

  try {
    const programState = await program.account.programState.fetch(
      programStatePubkey
    );
    console.log(`FUNCTION: ${programState.switchboardFunction}`);

    switchboardFunction = new FunctionAccount(
      switchboardProgram,
      programState.switchboardFunction
    );
    const functionState = await switchboardFunction.loadData();
    attestationQueuePubkey = functionState.attestationQueue;

    if (MrEnclave && MrEnclave.byteLength === 32) {
      let functionMrEnclaves = functionState.mrEnclaves.filter(
        (b) =>
          Buffer.compare(Buffer.from(b), Buffer.from(new Array(32).fill(0))) !==
          0
      );
      // if we need to, add MrEnclave measurement
      const mrEnclaveIdx = functionMrEnclaves.findIndex(
        (b) => Buffer.compare(Buffer.from(b), Buffer.from(MrEnclave)) === 0
      );
      if (mrEnclaveIdx === -1) {
        console.log(
          `MrEnclave missing from Function, adding to function config ...`
        );
        // we need to add the MrEnclave measurement
        const mrEnclavesLen = functionMrEnclaves.push(Array.from(MrEnclave));
        if (mrEnclavesLen > 32) {
          functionMrEnclaves = functionMrEnclaves.slice(32 - mrEnclavesLen);
        }
        const functionSetConfigTx = await switchboardFunction.setConfig({
          mrEnclaves: functionMrEnclaves,
        });
        console.log(`[TX] function_set_config: ${functionSetConfigTx}`);
      }
    }
  } catch (error) {
    if (!`${error}`.includes("Account does not exist or has no data")) {
      throw error;
    }

    // Attempt to load from env file
    if (process.env.SWITCHBOARD_FUNCTION_PUBKEY) {
      try {
        const myFunction = new FunctionAccount(
          switchboardProgram,
          process.env.SWITCHBOARD_FUNCTION_PUBKEY
        );
        const functionState = await myFunction.loadData();
        if (functionState.authority.equals(payer.publicKey)) {
          throw new Error(
            `$SWITCHBOARD_FUNCTION_PUBKEY.authority mismatch, expected ${payer.publicKey}, received ${functionState.authority}`
          );
        }
        switchboardFunction = myFunction;
        attestationQueuePubkey = functionState.attestationQueue;
      } catch (error) {
        console.error(
          `$SWITCHBOARD_FUNCTION_PUBKEY in your .env file is incorrect, please fix`
        );
      }
    }

    if (!switchboardFunction || !attestationQueuePubkey) {
      if (!process.env.DOCKER_IMAGE_NAME) {
        throw new Error(
          `You need to set DOCKER_IMAGE_NAME in your .env file to create a new Switchboard Function. Example:\n\tDOCKER_IMAGE_NAME=gallynaut/solana-simple-randomness-function`
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
      console.log(`Initializing new SwitchboardFunction ...`);
      const attestationQueue = new AttestationQueueAccount(
        switchboardProgram,
        attestationQueueAddress
      );
      await attestationQueue.loadData();
      const [functionAccount, functionInitTx] = await FunctionAccount.create(
        switchboardProgram,
        {
          name: "SIMPLE-RANDOMNESS",
          metadata:
            "https://github.com/switchboard-xyz/solana-simple-randomness-example/tree/main/switchboard-function",
          container: process.env.DOCKER_IMAGE_NAME,
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
      attestationQueuePubkey = attestationQueue.publicKey;
    }

    const tx = await program.methods
      .initialize()
      .accounts({
        payer: payer.publicKey,
        programState: programStatePubkey,
        authority: payer.publicKey,
        switchboardFunction: switchboardFunction.publicKey,
      })
      .rpc();
    console.log(`[TX] initialize: ${tx}`);
  }

  const [userPubkey] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("RANDOMNESS_USER"), payer.publicKey.toBytes()],
    program.programId
  );
  console.log(`USER: ${userPubkey}`);

  // check if user exists and get the request
  let switchboardRequest: FunctionRequestAccount;
  let switchboardRequestEscrowPubkey: anchor.web3.PublicKey;

  try {
    const userState = await program.account.userState.fetch(userPubkey);
    console.log(`REQUEST: ${userState.switchboardRequest}`);

    switchboardRequest = new FunctionRequestAccount(
      switchboardProgram,
      userState.switchboardRequest
    );
    const requestState = await switchboardRequest.loadData();
    switchboardRequestEscrowPubkey = requestState.escrow;
  } catch (error) {
    if (!`${error}`.includes("Account does not exist or has no data")) {
      throw error;
    }

    const switchboardRequestKeypair = anchor.web3.Keypair.generate();
    const switchboardRequestEscrow = anchor.utils.token.associatedAddress({
      mint: switchboardProgram.mint.address,
      owner: switchboardRequestKeypair.publicKey,
    });

    const tx = await program.methods
      .createUser()
      .accounts({
        payer: payer.publicKey,
        programState: programStatePubkey,
        user: userPubkey,
        authority: payer.publicKey,
        switchboard: switchboardProgram.attestationProgramId,
        switchboardState: switchboardProgram.attestationProgramState.publicKey,
        switchboardAttestationQueue: attestationQueuePubkey,
        switchboardFunction: switchboardFunction.publicKey,
        switchboardRequest: switchboardRequestKeypair.publicKey,
        switchboardRequestEscrow: switchboardRequestEscrow,
        switchboardMint: switchboardProgram.mint.address,
      })
      .signers([switchboardRequestKeypair])
      .rpc();
    console.log(`[TX] create_user: ${tx}`);

    switchboardRequest = new FunctionRequestAccount(
      switchboardProgram,
      switchboardRequestKeypair.publicKey
    );
    switchboardRequestEscrowPubkey = switchboardRequestEscrow;
  }

  // NOW LETS TRIGGER THE REQUEST
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
          switchboardAttestationQueue: attestationQueuePubkey,
          switchboardFunction: switchboardFunction.publicKey,
          switchboardRequest: switchboardRequest.publicKey,
          switchboardRequestEscrow: switchboardRequestEscrowPubkey,
        })
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
    console.log(userState);
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

  const userState = await program.account.userState.fetch(userPubkey);

  console.log(`\n### METRICS`);

  const fullDuration = (requestSettleTime - requestStartTime) / 1000;
  console.log(`Settlement Time: ${fullDuration.toFixed(3)}`);
  // console.log(
  //   `Settlement Slots: ${event.slot - userState.currentRound.requestSlot}`
  // );

  // if (fs.existsSync("metrics.csv")) {
  //   fs.appendFileSync(
  //     "metrics.csv",
  //     `${BNtoDateTimeString(event.timestamp)},${event.roundId},${
  //       event.userWon
  //     },${event.result},${userState.currentRound.requestSlot},${event.slot},${
  //       event.slot - userState.currentRound.requestSlot
  //     },${fullDuration.toFixed(3)},${betTx}\n`
  //   );
  // } else {
  //   fs.writeFileSync(
  //     "metrics.csv",
  //     `timestamp,roundId,userWon,result,requestSlot,settledSlot,slotDifference,settlementTime,tx\n${BNtoDateTimeString(
  //       event.timestamp
  //     )},${event.roundId},${event.userWon},${event.result},${
  //       userState.currentRound.requestSlot
  //     },${event.slot},${
  //       event.slot - userState.currentRound.requestSlot
  //     },${fullDuration.toFixed(3)},${betTx}\n`
  //   );
  // }
})();
