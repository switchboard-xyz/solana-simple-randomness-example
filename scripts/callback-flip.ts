import {
  AttestationQueueAccount,
  FunctionAccount,
  FunctionRequestAccount,
  SwitchboardProgram,
  attestationTypes,
  loadKeypair,
} from "@switchboard-xyz/solana.js";
import * as anchor from "@coral-xyz/anchor";
import { SwitchboardRandomnessCallback } from "../target/types/switchboard_randomness_callback";
import dotenv from "dotenv";
import {
  CHECK_ICON,
  FAILED_ICON,
  addMrEnclave,
  loadDefaultQueue,
  loadSwitchboardFunctionEnv,
  myMrEnclave,
} from "./utils";
import { TestMeter } from "./meter";
dotenv.config();

interface UserGuessSettledEvent {
  user: anchor.web3.PublicKey;
  userWon: boolean;
  requestTimestamp: anchor.BN;
  settledTimestamp: anchor.BN;
}

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

  const testMeter = new TestMeter(program, "callback-flip", {
    useSolUnits: true,
  });

  const [programStatePubkey] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("SIMPLE_RANDOMNESS")],
    program.programId
  );
  console.log(`PROGRAM_STATE: ${programStatePubkey}`);

  let switchboardFunction: FunctionAccount | undefined = undefined;
  let functionState: attestationTypes.FunctionAccountData | undefined =
    undefined;

  let attestationQueue: AttestationQueueAccount | undefined = undefined;

  /////////////////////////////////////////
  // GET OR CREATE CREATE PROGRAM STATE  //
  // GLOBAL ACCT & SWITCHBOARD FUNCTION  //
  /////////////////////////////////////////
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
  } catch (error) {
    if (!`${error}`.includes("Account does not exist or has no data")) {
      throw error;
    }

    if (!switchboardFunction) {
      // First try to load from our .env file
      [switchboardFunction, functionState] = await loadSwitchboardFunctionEnv(
        switchboardProgram
      );

      // Load the default attestation queue by devnet or mainnet genesis hash
      attestationQueue = new AttestationQueueAccount(
        switchboardProgram,
        functionState.attestationQueue
      );
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
    }

    if (!switchboardFunction) {
      throw new Error(
        "Failed to load Switchboard Function from .env file and failed to create a new function on-chain."
      );
    }

    try {
      // If we have a measurement.txt in the workspace, try to add it to
      // our function.
      if (myMrEnclave) {
        const addEnclaveTxn = await addMrEnclave(
          switchboardProgram,
          switchboardFunction,
          functionState
        );
        console.log(
          `[TX] function_set_config (added MrEnclave): ${addEnclaveTxn}`
        );
      }
    } catch {}

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

    // Create a new user account
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

  /////////////////////////////////
  // TRIGGER THE REQUEST   ////////
  /////////////////////////////////

  const {
    data: [event, slot],
    receipt,
  } = await testMeter.runAndAwaitEvent(
    "guess",
    "UserGuessSettled",
    async (meter) => {
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
          meter.addReceipt({
            tx: tx,
            name: "guess",
          });

          console.log(`[TX] guess: ${tx}\n`);

          return tx;
        });
    }
  );

  if (event.userWon) {
    console.log(`\n${CHECK_ICON} You won!\n`);
  } else {
    console.log(`\n${FAILED_ICON} Sorry, you lost!\n`);
  }

  await testMeter.stop();

  console.log(`\n### METRICS`);

  const fullDuration = receipt.time.delta;
  console.log(`Settlement Time: ${fullDuration.toFixed(3)} seconds`);

  console.log(
    `Cost: ${receipt.balance.delta} ${
      testMeter.config.balance.units === "sol" ? "SOL" : "lamports"
    }`
  );

  testMeter.print();
})();
