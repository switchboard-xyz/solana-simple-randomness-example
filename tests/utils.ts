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
  MRENCLAVE: RawBuffer,
  recentSlot?: number
): Promise<[BootstrappedAttestationQueue, FunctionAccount]> {
  const switchboardProgram = await SwitchboardProgram.fromProvider(provider);
  const switchboard = await AttestationQueueAccount.bootstrapNewQueue(
    switchboardProgram
  );

  const [switchboardFunction] =
    await switchboard.attestationQueue.account.createFunction({
      name: "test function",
      metadata: "this function handles XYZ for my protocol",
      container: "org/container",
      version: "latest",
      mrEnclave: parseRawBuffer(MRENCLAVE, 32),
      recentSlot,
    });

  return [switchboard, switchboardFunction];
}
