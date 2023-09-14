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
import { SwitchboardRandomnessCallback } from "../target/types/switchboard_randomness_callback";
import { parseRawMrEnclave, promiseWithTimeout } from "@switchboard-xyz/common";
import fs from "fs";
import dotenv from "dotenv";
import {
  addMrEnclave,
  loadDefaultQueue,
  loadSwitchboardFunctionEnv,
  myMrEnclave,
} from "./utils";
dotenv.config();

interface UserGuessSettledEvent {
  user: anchor.web3.PublicKey;
  userWon: boolean;
  requestTimestamp: anchor.BN;
  settledTimestamp: anchor.BN;
}

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

  const program: anchor.Program<SwitchboardRandomnessCallback> =
    anchor.workspace.SwitchboardRandomnessCallback;

  const switchboardProgram = await SwitchboardProgram.fromProvider(provider);

  const [programStatePubkey] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("SIMPLE_RANDOMNESS")],
    program.programId
  );
  console.log(`PROGRAM_STATE: ${programStatePubkey}`);

  let switchboardFunction: FunctionAccount | undefined = undefined;
  let functionState: attestationTypes.FunctionAccountData | undefined =
    undefined;

  let attestationQueue: AttestationQueueAccount | undefined = undefined;

  try {
    const programState = await program.account.programState.fetch(
      programStatePubkey
    );
    console.log(`FUNCTION: ${programState.switchboardFunction}`);

    switchboardFunction = new FunctionAccount(
      switchboardProgram,
      programState.switchboardFunction
    );
    functionState = await switchboardFunction.loadData();
    attestationQueue = new AttestationQueueAccount(
      switchboardProgram,
      functionState.attestationQueue
    );

    if (MrEnclave) {
      const addEnclaveTxn = await addMrEnclave(
        switchboardProgram,
        switchboardFunction,
        functionState
      );
      console.log(
        `[TX] function_set_config (added MrEnclave): ${addEnclaveTxn}`
      );
    }
  } catch (error) {
    if (!`${error}`.includes("Account does not exist or has no data")) {
      throw error;
    }

    if (!switchboardFunction) {
      [switchboardFunction, functionState] = await loadSwitchboardFunctionEnv(
        switchboardProgram
      );

      attestationQueue = new AttestationQueueAccount(
        switchboardProgram,
        functionState.attestationQueue
      );

      if (MrEnclave) {
        const addEnclaveTxn = await addMrEnclave(
          switchboardProgram,
          switchboardFunction,
          functionState
        );
        console.log(
          `[TX] function_set_config (added MrEnclave): ${addEnclaveTxn}`
        );
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

    if (!switchboardFunction) {
      // Get the Attestation queue address from the clusters genesis hash
      attestationQueue = await loadDefaultQueue(switchboardProgram);

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
        switchboardAttestationQueue: attestationQueue.publicKey,
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
          switchboardAttestationQueue: attestationQueue.publicKey,
          switchboardFunction: switchboardFunction.publicKey,
          switchboardRequest: switchboardRequest.publicKey,
          switchboardRequestEscrow: switchboardRequestEscrowPubkey,
        })
        .rpc()
        .then((tx) => {
          console.log(`[TX] guess: ${tx}\n`);
          betTx = tx;
        })
        .catch((err) => {
          console.log("here");
          console.error(err);
          throw err;
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
