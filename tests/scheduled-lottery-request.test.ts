import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ScheduledLotteryRequest } from "../target/types/scheduled_lottery_request";
import {
  AttestationQueueAccount,
  BootstrappedAttestationQueue,
  FunctionAccount,
  FunctionRequestAccount,
  SwitchboardProgram,
  attestationTypes,
} from "@switchboard-xyz/solana.js";
import { parseRawMrEnclave, sleep } from "@switchboard-xyz/common";
import { assert } from "chai";
import { loadSwitchboard } from "./utils";

// This value doesnt matter for our tests because we are not validating
// the execution off-chain.
const MRENCLAVE = parseRawMrEnclave(
  "0x17e9c995dd5f55e4e52f9ff13ae79fd800849d3be966f1317e1e7c7809bad538",
  true
);

describe("scheduled-lottery-request", () => {
  const provider = anchor.AnchorProvider.env();
  const payer = (provider.wallet as anchor.Wallet).payer;

  anchor.setProvider(provider);

  const program = anchor.workspace
    .ScheduledLotteryRequest as Program<ScheduledLotteryRequest>;

  console.log(`ScheduledLotteryRequest PID: ${program.programId}`);

  // Derive our PDAs.
  const [programStatePubkey] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("SIMPLE_LOTTERY")],
    program.programId
  );
  const [lotteryPubkey] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("LOTTERY_STATE"), payer.publicKey.toBytes()],
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
      MRENCLAVE,
      await provider.connection.getSlot()
    );
  });

  ///////////////////////////////////////////////////////
  // Initialize the program and set the Switchboard Function
  ///////////////////////////////////////////////////////
  it("initialize", async () => {
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
  });

  ///////////////////////////////////////////////////////
  // Create our lottery account
  ///////////////////////////////////////////////////////
  it("create_lottery", async () => {
    console.log(`[INFO] lottery: ${lotteryPubkey.toBase58()}`);
    await sleep(3000);
    try {
      const tx = await program.methods
        .createLottery(new anchor.BN(0), 10)
        .accounts({
          payer: payer.publicKey,
          programState: programStatePubkey,
          lottery: lotteryPubkey,
          lotteryEscrow:
            switchboard.program.mint.getAssociatedAddress(lotteryPubkey),
          authority: payer.publicKey,
          switchboard: switchboard.program.attestationProgramId,
          switchboardMint: switchboard.program.mint.address,
          switchboardState:
            switchboard.program.attestationProgramState.publicKey,
          switchboardAttestationQueue: switchboard.attestationQueue.publicKey,
          switchboardFunction: switchboardFunction.publicKey,
          switchboardRequest: switchboardRequestKeypair.publicKey,
          switchboardRequestEscrow:
            switchboard.program.mint.getAssociatedAddress(
              switchboardRequestKeypair.publicKey
            ),
        })
        .signers([switchboardRequestKeypair])
        .preInstructions([
          anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({
            units: 300_000,
          }),
        ])
        .rpc();
      console.log(`[TX] create_lottery: ${tx}`);
    } catch (error) {
      console.error(error);
      throw error;
    }
  });

  it("buy_ticket", async () => {
    const user1 = await createUser(
      provider,
      0.001 * anchor.web3.LAMPORTS_PER_SOL
    );
    const tx = await program.methods
      .buyTicket()
      .accounts({
        payer: user1.publicKey,
        lottery: lotteryPubkey,
        escrow: anchor.utils.token.associatedAddress({
          mint: switchboard.program.mint.address,
          owner: lotteryPubkey,
        }),
      })
      .signers([user1])
      .rpc();
    console.log(`[TX] buy_ticket: ${tx}`);

    const lotteryState = await program.account.lotteryState.fetch(
      lotteryPubkey
    );
    assert(lotteryState.numTickets === 1);
  });

  ///////////////////////////////////////////////////////
  // Mock off-chain settle logic
  ///////////////////////////////////////////////////////
  it("draw_winner", async () => {
    const initialLotteryState = await program.account.lotteryState.fetch(
      lotteryPubkey
    );
    const closingSlot = initialLotteryState.closeSlot.toNumber();
    const winner = initialLotteryState.tickets[0];

    let slot = await provider.connection.getSlot();
    while (slot < closingSlot) {
      console.log(`[INFO] waiting for closing slot: ${closingSlot} (${slot})`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      slot = await provider.connection.getSlot();
    }

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
          errorCode: 0,
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
      .drawWinner(winner)
      .accounts({
        lottery: lotteryPubkey,
        escrow: anchor.utils.token.associatedAddress({
          mint: switchboard.program.mint.address,
          owner: lotteryPubkey,
        }),
        winner,
        switchboard: switchboard.program.attestationProgramId,
        switchboardState: switchboard.program.attestationProgramState.publicKey,
        switchboardFunction: switchboardFunction.publicKey,
        switchboardRequest: switchboardRequestKeypair.publicKey,
        enclaveSigner: enclaveSigner.publicKey,
        switchboardRequestEscrow: anchor.utils.token.associatedAddress({
          mint: switchboard.program.mint.address,
          owner: switchboardRequestKeypair.publicKey,
        }),
      })
      .preInstructions([fnRequestVerifyIxn])
      .signers([enclaveSigner, switchboard.verifier.signer])
      .rpc({ skipPreflight: true });
    console.log(`[TX] draw_winner: ${tx}`);

    const lotteryState = await program.account.lotteryState.fetch(
      lotteryPubkey
    );
    assert(lotteryState.hasEnded);
    assert(lotteryState.winner.equals(winner));
  });
});

async function createUser(
  provider: anchor.AnchorProvider,
  lamports: number
): Promise<anchor.web3.Keypair> {
  const payer = (provider.wallet as anchor.Wallet).payer;
  const user = anchor.web3.Keypair.generate();

  const messageV0 = new anchor.web3.TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: (await provider.connection.getLatestBlockhash()).blockhash,
    instructions: [
      anchor.web3.SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: user.publicKey,
        lamports,
      }),
    ],
  }).compileToV0Message();
  const transaction = new anchor.web3.VersionedTransaction(messageV0);
  transaction.sign([payer]);

  const txid = await provider.connection.sendTransaction(transaction);
  return user;
}
