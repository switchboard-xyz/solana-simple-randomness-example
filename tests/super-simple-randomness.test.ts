import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SuperSimpleRandomness } from "../target/types/super_simple_randomness";
import {
  AttestationQueueAccount,
  BootstrappedAttestationQueue,
  FunctionAccount,
  FunctionRequestAccount,
  SwitchboardProgram,
  attestationTypes,
} from "@switchboard-xyz/solana.js";
import { parseRawMrEnclave } from "@switchboard-xyz/common";
import { loadSwitchboard } from "./utils";

// This value doesnt matter for our tests because we are not validating
// the execution off-chain.
const MRENCLAVE = parseRawMrEnclave(
  "0x17e9c995dd5f55e4e52f9ff13ae79fd800849d3be966f1317e1e7c7809bad538",
  true
);

describe("super-simple-randomness", () => {
  const provider = anchor.AnchorProvider.env();
  const payer = (provider.wallet as anchor.Wallet).payer;

  anchor.setProvider(provider);

  const program = anchor.workspace
    .SuperSimpleRandomness as Program<SuperSimpleRandomness>;

  console.log(`SuperSimpleRandomness PID: ${program.programId}`);

  // Derive our users pubkey for the randomness program.
  const [userPubkey] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("RANDOMNESS_USER"), payer.publicKey.toBytes()],
    program.programId
  );

  ///////////////////////////////////////////////////////
  // Switchboard setup
  ///////////////////////////////////////////////////////
  let switchboard: BootstrappedAttestationQueue;
  let switchboardFunction: FunctionAccount;
  const switchboardRequestKeypair = anchor.web3.Keypair.generate();

  before(async () => {
    [switchboard, switchboardFunction] = await loadSwitchboard(
      provider,
      MRENCLAVE
    );
  });

  ///////////////////////////////////////////////////////
  // Submit a guess
  ///////////////////////////////////////////////////////
  it("guess", async () => {
    const tx = await program.methods
      .guess(1)
      .accounts({
        payer: payer.publicKey,
        user: userPubkey,
        authority: payer.publicKey,
        switchboard: switchboard.program.attestationProgramId,
        switchboardState: switchboard.program.attestationProgramState.publicKey,
        switchboardAttestationQueue: switchboard.attestationQueue.publicKey,
        switchboardFunction: switchboardFunction.publicKey,
        switchboardRequest: switchboardRequestKeypair.publicKey,
        switchboardRequestEscrow: anchor.utils.token.associatedAddress({
          mint: switchboard.program.mint.address,
          owner: switchboardRequestKeypair.publicKey,
        }),
        switchboardMint: switchboard.program.mint.address,
      })
      .signers([switchboardRequestKeypair])
      .rpc();
    console.log(`[TX] guess: ${tx}`);
  });

  ///////////////////////////////////////////////////////
  // Mock off-chain settle logic
  ///////////////////////////////////////////////////////
  it("settle", async () => {
    // First, generate a new keypair to sign our instruction
    // Normally this happens within the enclave
    const enclaveSigner = anchor.web3.Keypair.generate();

    // Load the Switchboard account states
    const [_sbRequestAccount, sbRequestState] =
      await FunctionRequestAccount.load(
        switchboard.program,
        switchboardRequestKeypair.publicKey
      );
    const sbFunctionState = await switchboardFunction.loadData();

    // We need a wrapped SOL TokenAccount to receive the oracle reward from the fn request escrow
    const rewardAddress =
      await switchboard.program.mint.getOrCreateAssociatedUser(payer.publicKey);

    // Next, generate the function_request_verify ixn that we must call before running
    // any of our emitted instructions.
    const fnRequestVerifyIxn = attestationTypes.functionRequestVerify(
      switchboard.program,
      {
        params: {
          observedTime: new anchor.BN(Math.floor(Date.now() / 1000)),
          isFailure: false,
          mrEnclave: Array.from(MRENCLAVE),
          requestSlot: sbRequestState.activeRequest.requestSlot,
          containerParamsHash: sbRequestState.containerParamsHash,
        },
      },
      {
        request: switchboardRequestKeypair.publicKey,
        functionEnclaveSigner: enclaveSigner.publicKey,
        escrow: sbRequestState.escrow,
        function: switchboardFunction.publicKey,
        functionEscrow: sbFunctionState.escrowTokenWallet,
        verifierQuote: switchboard.verifier.publicKey,
        verifierEnclaveSigner: switchboard.verifier.signer.publicKey,
        verifierPermission: switchboard.verifier.permissionAccount.publicKey,
        state: switchboard.program.attestationProgramState.publicKey,
        attestationQueue: switchboard.attestationQueue.publicKey,
        receiver: rewardAddress,
        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
      }
    );

    const tx = await program.methods
      .settle(1)
      .accounts({
        user: userPubkey,
        switchboardFunction: switchboardFunction.publicKey,
        switchboardRequest: switchboardRequestKeypair.publicKey,
        enclaveSigner: enclaveSigner.publicKey,
      })
      .preInstructions([fnRequestVerifyIxn])
      .signers([enclaveSigner, switchboard.verifier.signer])
      .rpc();
    console.log(`[TX] settle: ${tx}`);

    const userState = await program.account.userState.fetch(userPubkey);
    if (userState.guess === userState.result) {
      console.log(`[RESULT] user won!`);
    } else {
      console.log(`[RESULT] user lost :(`);
    }
  });
});
