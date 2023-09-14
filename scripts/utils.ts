import {
  AttestationQueueAccount,
  DEVNET_GENESIS_HASH,
  FunctionAccount,
  MAINNET_GENESIS_HASH,
  SwitchboardProgram,
  attestationTypes,
} from "@switchboard-xyz/solana.js";
import * as anchor from "@coral-xyz/anchor";
import { parseRawMrEnclave } from "@switchboard-xyz/common";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import chalk from "chalk";
dotenv.config();

export const PLUS_ICON = chalk.green("\u002B ");

export const CHECK_ICON = chalk.green("\u2714 ");

export const FAILED_ICON = chalk.red("\u2717 ");

export async function loadDefaultQueue(switchboardProgram: SwitchboardProgram) {
  const genesisHash =
    await switchboardProgram.provider.connection.getGenesisHash();
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

  return new AttestationQueueAccount(
    switchboardProgram,
    attestationQueueAddress
  );
}

export const myMrEnclave: Uint8Array | undefined = process.env.MR_ENCLAVE
  ? parseRawMrEnclave(process.env.MR_ENCLAVE)
  : fs.existsSync(path.join(__dirname, "..", "measurement.txt"))
  ? parseRawMrEnclave(
      fs
        .readFileSync(path.join(__dirname, "..", "measurement.txt"), "utf-8")
        .trim()
    )
  : undefined;

/**
 * Attempt to load our Switchboard Function from the .env file
 */
export async function loadSwitchboardFunctionEnv(
  switchboardProgram: SwitchboardProgram
): Promise<
  [
    FunctionAccount | undefined,
    attestationTypes.FunctionAccountData | undefined
  ]
> {
  if (process.env.SWITCHBOARD_FUNCTION_PUBKEY) {
    console.log(
      `[env] SWITCHBOARD_FUNCTION_PUBKEY: ${process.env.SWITCHBOARD_FUNCTION_PUBKEY}`
    );
    const functionAccountInfo =
      await switchboardProgram.provider.connection.getAccountInfo(
        new anchor.web3.PublicKey(process.env.SWITCHBOARD_FUNCTION_PUBKEY)
      );

    if (!functionAccountInfo) {
      console.error(
        `$SWITCHBOARD_FUNCTION_PUBKEY in your .env file is incorrect, please fix. Creating a new Switchboard Function ...`
      );
    } else {
      // We can decode the AccountInfo to reduce our network calls
      return await FunctionAccount.decode(
        switchboardProgram,
        functionAccountInfo
      );
    }
  }

  return [undefined, undefined];
}

export async function addMrEnclave(
  switchboardProgram: SwitchboardProgram,
  switchboardFunction: FunctionAccount,
  _functionState: attestationTypes.FunctionAccountData | undefined
): Promise<string | undefined> {
  const payer = (switchboardProgram.provider.wallet as anchor.Wallet).payer;

  const functionState =
    _functionState ?? (await switchboardFunction.loadData());

  const isFunctionAuthority = functionState.authority.equals(payer.publicKey);

  if (!FunctionAccount.hasMrEnclave(functionState.mrEnclaves, myMrEnclave)) {
    // Make sure we can add this enclave or else it will fail to verify on-chain
    if (!isFunctionAuthority) {
      throw new Error(
        `Function is missing the MrEnclave value ${myMrEnclave}. Attempted to add this to the Function config automatically but you are not the function authority (${functionState.authority}). Try creating your own Switchboard Function with '${payer.publicKey}' as the authority, then set SWITCHBOARD_FUNCTION_PUBKEY in your .env file.`
      );
    }

    const addMrEnclaveTx = await switchboardFunction.tryAddMrEnclave(
      myMrEnclave,
      { functionState, force: true }
    );

    return addMrEnclaveTx;
  }

  return undefined;
}
