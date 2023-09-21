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

    console.log(`Program state not found, initializing ...`);

    if (!switchboardFunction) {
      // First try to load from our .env file
      [switchboardFunction, functionState] = await loadSwitchboardFunctionEnv(
        switchboardProgram
      );

      if (functionState) {
        // Load the default attestation queue by devnet or mainnet genesis hash
        attestationQueue = new AttestationQueueAccount(
          switchboardProgram,
          functionState.attestationQueue
        );
      }
    }

    if (!switchboardFunction) {
      // Get the Attestation queue address from the clusters genesis hash
      attestationQueue = await loadDefaultQueue(switchboardProgram);

      await testMeter.run("function_init", async (meter) => {
        let tx: string;
        [switchboardFunction, tx] = await FunctionAccount.create(
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

        meter.addReceipt({
          name: "function_init",
          tx: tx,
          rent: [
            {
              account: "FunctionAccount",
              description: "SwitchboardFunction account",
              cost:
                (await program.provider.connection.getMinimumBalanceForRentExemption(
                  switchboardProgram.attestationAccount.functionAccountData.size
                )) / anchor.web3.LAMPORTS_PER_SOL,
            },
            {
              account: "SwitchboardWallet",
              description: "Re-useable wallet for Switchboard functions",
              cost:
                (await program.provider.connection.getMinimumBalanceForRentExemption(
                  switchboardProgram.attestationAccount.switchboardWallet.size
                )) / anchor.web3.LAMPORTS_PER_SOL,
            },
            {
              account: "SwitchboardWallet Escrow",
              description: "Wrapped SOL token account used to pay for requests",
              cost:
                (await program.provider.connection.getMinimumBalanceForRentExemption(
                  165 /** TokenAccount bytes */
                )) / anchor.web3.LAMPORTS_PER_SOL,
            },
            {
              account: "AddressLookupTable",
              description:
                "Solana Address Lookup table to support versioned transactions in the future",
              cost:
                (await program.provider.connection.getMinimumBalanceForRentExemption(
                  568 /** Address Lookup Account bytes */
                )) / anchor.web3.LAMPORTS_PER_SOL,
            },
          ],
        });

        return tx;
      });
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

    await testMeter.run("initialize", async (meter) => {
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

      meter.addReceipt({
        name: "initialize",
        tx: tx,
        rent: [
          {
            account: "ProgramState",
            description:
              "Global account to hold our Switchboard Function pubkey to validate user requests",
            cost:
              (await program.provider.connection.getMinimumBalanceForRentExemption(
                program.account.programState.size
              )) / anchor.web3.LAMPORTS_PER_SOL,
          },
        ],
      });

      return tx;
    });
  }

  const [userPubkey] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("RANDOMNESS_USER"), payer.publicKey.toBytes()],
    program.programId
  );

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

    // Add the MrEnclave value to our config if its missing
    const switchboardFunction = new FunctionAccount(
      switchboardProgram,
      requestState.function
    );
    const functionState = await switchboardFunction.loadData();
    const addEnclaveTxn = await addMrEnclave(
      switchboardProgram,
      switchboardFunction,
      functionState
    );
    if (addEnclaveTxn) {
      console.log(
        `[TX] function_set_config (added MrEnclave): ${addEnclaveTxn}`
      );
    }
  } catch (error) {
    if (!`${error}`.includes("Account does not exist or has no data")) {
      throw error;
    }

    await testMeter.run("create_user", async (meter) => {
      // Create a new user account

      // Create a new request account with a fresh keypair
      const switchboardRequestKeypair = anchor.web3.Keypair.generate();
      switchboardRequest = new FunctionRequestAccount(
        switchboardProgram,
        switchboardRequestKeypair.publicKey
      );

      switchboardRequestEscrowPubkey = anchor.utils.token.associatedAddress({
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
          switchboardState:
            switchboardProgram.attestationProgramState.publicKey,
          switchboardAttestationQueue: attestationQueue.publicKey,
          switchboardFunction: switchboardFunction.publicKey,
          switchboardRequest: switchboardRequestKeypair.publicKey,
          switchboardRequestEscrow: switchboardRequestEscrowPubkey,
          switchboardMint: switchboardProgram.mint.address,
        })
        .signers([switchboardRequestKeypair])
        .rpc();
      console.log(`[TX] create_user: ${tx}`);

      meter.addReceipt({
        name: "create_user",
        tx: tx,
        rent: [
          {
            account: "FunctionRequest",
            description:
              "Rent exemption for the Switchboard FunctionRequestAccount",
            cost:
              (await program.provider.connection.getMinimumBalanceForRentExemption(
                await program.provider.connection
                  .getAccountInfo(switchboardRequest.publicKey)
                  .then((a) => a?.data.length)
                  .catch(
                    () =>
                      switchboardProgram.attestationAccount
                        .functionRequestAccountData.size + 512
                  )
              )) / anchor.web3.LAMPORTS_PER_SOL,
          },
          {
            account: "FunctionRequest Escrow",
            description: "Wrapped SOL token account used to pay for requests",
            cost:
              (await program.provider.connection.getMinimumBalanceForRentExemption(
                165 /** TokenAccount bytes */
              )) / anchor.web3.LAMPORTS_PER_SOL,
          },
          {
            account: "UserState",
            cost:
              (await program.provider.connection.getMinimumBalanceForRentExemption(
                program.account.userState.size
              )) / anchor.web3.LAMPORTS_PER_SOL,
          },
        ],
      });

      return tx;
    });
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
