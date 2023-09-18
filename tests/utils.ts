import * as anchor from "@coral-xyz/anchor";
import { RawBuffer } from "@switchboard-xyz/common";
import {
  AttestationQueueAccount,
  BootstrappedAttestationQueue,
  FunctionAccount,
  SwitchboardProgram,
  parseRawBuffer,
} from "@switchboard-xyz/solana.js";

export async function loadSwitchboard(
  provider: anchor.AnchorProvider,
  MRENCLAVE: RawBuffer
): Promise<[BootstrappedAttestationQueue, FunctionAccount]> {
  const switchboardProgram = await SwitchboardProgram.fromProvider(provider);
  const switchboard = await AttestationQueueAccount.bootstrapNewQueue(
    switchboardProgram
  );

  const [switchboardFunction] =
    await switchboard.attestationQueue.account.createFunction({
      name: "test function",
      metadata: "this function handles XYZ for my protocol",
      schedule: "", // on-demand updates only
      container: "org/container",
      version: "latest",
      mrEnclave: parseRawBuffer(MRENCLAVE),
    });

  return [switchboard, switchboardFunction];
}
