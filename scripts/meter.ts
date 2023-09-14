import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import {
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  SwitchboardProgram,
} from "@switchboard-xyz/solana.js";
import {
  promiseWithTimeout,
  BNtoDateTimeString,
} from "@switchboard-xyz/common";

interface TxReceipt {
  name: string;
  tx: string;
  description?: string;
  rent?: { account: string; cost: number; description?: string }[];
  sbFee?: number;
}

type StageRecord<T> = Record<string, T>;

type AddReceipt = (...receipt: TxReceipt[]) => void;
type AddLog = (...log: string[]) => void;

type MeterRunner = {
  addReceipt: AddReceipt;
  addLog: AddLog;
};

type SetTestMeterConfig = {
  // convert balances from lamports to SOL
  useSolUnits?: boolean;
  // convert milliseconds to seconds
  useMilliseconds?: boolean;
};

type StageResult<T extends TxReceipt = TxReceipt> = {
  stage: string;
  balance: {
    start: number;
    end: number | undefined;
    delta: number | undefined;
  };
  time: { start: number; end: number | undefined; delta: number | undefined };
  receipts: T[];
  logs: string[];
};

type FinalStageResult = StageResult<
  TxReceipt & { meta?: anchor.web3.ParsedTransactionMeta }
> & {
  totalCost: number;
};

// type Metric<T> = {
//   start: T;
//   end: T;
//   delta: T;
// };

type TestMeterConfig = {
  balance: {
    units: "lamports" | "sol";
  };
  time: {
    units: "seconds" | "milliseconds";
  };
};

export class TestMeter {
  public config: Required<TestMeterConfig>;

  private getClusterPromise = this.connection
    .getGenesisHash()
    .catch(() => "")
    .then((genesisHash) => {
      return genesisHash === MAINNET_GENESIS_HASH
        ? "mainnet-beta"
        : genesisHash === DEVNET_GENESIS_HASH
        ? "devnet"
        : "unknown";
    });

  private _initTime = Math.round(Date.now() / 1000);

  public stages: string[] = new Array<string>();
  public stage: string = "";
  public isStageActive = false;

  public _stages: StageRecord<StageResult> = {};

  constructor(
    public readonly program: anchor.Program<anchor.Idl>,
    public readonly name: string,
    _config?: SetTestMeterConfig
  ) {
    this.config = {
      balance: { units: _config?.useSolUnits ?? false ? "sol" : "lamports" },
      time: {
        units: _config?.useMilliseconds ?? false ? "milliseconds" : "seconds",
      },
    };
  }

  public static async fromProvider(
    provider: anchor.AnchorProvider,
    meterName: string,
    _config?: SetTestMeterConfig
  ): Promise<TestMeter> {
    const switchboardProgram = await SwitchboardProgram.fromProvider(provider);
    return new TestMeter(
      (switchboardProgram as any)._program,
      meterName,
      _config
    );
  }

  public get payer(): anchor.web3.Keypair {
    return (
      (this.program.provider as anchor.AnchorProvider).wallet as anchor.Wallet
    ).payer;
  }

  public get connection(): anchor.web3.Connection {
    return this.program.provider.connection;
  }

  private parseBalance(balance: number): number {
    return this.config.balance.units === "sol"
      ? balance / anchor.web3.LAMPORTS_PER_SOL
      : balance;
  }

  private parseTime(time: number): number {
    return this.config.time.units === "milliseconds" ? time : time / 1000;
  }

  public getStage(name: string): StageResult {
    const stage = this._stages[name];
    if (!stage) {
      throw new Error(`Stage ${name} does not exist`);
    }
    return {
      ...stage,
      balance: {
        start: this.parseBalance(stage.balance.start),
        end: this.parseBalance(stage.balance.end),
        delta: this.parseBalance(stage.balance.delta),
      },
      time: {
        start: this.parseTime(stage.time.start),
        end: this.parseTime(stage.time.end),
        delta: this.parseTime(stage.time.delta),
      },
    };
  }

  toJSON(): StageResult {
    return this.getStage(this.stage);
  }

  private async getBalance(): Promise<number> {
    return await this.connection.getBalance(this.payer.publicKey);
  }

  private async endStage(): Promise<StageResult> {
    this._stages[this.stage].time.end = Date.now();
    this._stages[this.stage].time.delta =
      this._stages[this.stage].time.end - this._stages[this.stage].time.start;

    this._stages[this.stage].balance.end = await this.getBalance();
    this._stages[this.stage].balance.delta =
      this._stages[this.stage].balance.end -
      this._stages[this.stage].balance.start;

    this.isStageActive = false;

    return this.toJSON();
  }

  private async initNewStage(name: string): Promise<void> {
    if (!name) {
      throw new Error("Stage name must be provided");
    }

    this.stages.push(name);
    this.stage = name;

    this._stages[this.stage] = {
      stage: this.stage,
      time: { start: Date.now(), end: undefined, delta: undefined },
      balance: {
        start: await this.getBalance(),
        end: undefined,
        delta: undefined,
      },
      receipts: [],
      logs: [],
    };

    this.isStageActive = true;

    return;
  }

  private runner(): MeterRunner {
    return {
      addReceipt: (...items: TxReceipt[]) =>
        this._stages[this.stage].receipts.push(...items),
      addLog: (...logs: string[]) =>
        this._stages[this.stage].logs.push(...logs),
    };
  }

  // Starts a new stage, records the payers balance,
  // starts the timer and runs the callback.
  public async run<T>(
    name: string,
    callback: (meter: MeterRunner) => Promise<T>
  ): Promise<{ data: T; receipt: StageResult }> {
    if (this.isStageActive) {
      await this.endStage();
    }

    await this.initNewStage(name);

    const data = await callback(this.runner());

    const receipt = await this.endStage();

    return { data, receipt };
  }

  public async runAndAwaitEvent(
    name: string,
    eventName: string,
    callback: (runner: MeterRunner) => Promise<void>,
    timeout = 45_000
  ): Promise<{ data: [any, number]; receipt: StageResult }> {
    let listener = null;
    const closeListener = async () => {
      if (listener !== null) {
        await this.program.removeEventListener(listener);
        listener = null;
      }
    };

    const runResult = await this.run(name, async (meter) => {
      const callbackPromise = new Promise(
        async (resolve: (value: [any, number]) => void, _reject) => {
          listener = this.program.addEventListener(eventName, (event, slot) => {
            resolve([event, slot]);
          });
          await callback(this.runner());
        }
      );

      const result = await promiseWithTimeout(timeout, callbackPromise);
      await closeListener();
      return result;
    }).catch(async (err) => {
      if (listener) {
        await this.program.removeEventListener(listener);
        listener = null;
      }
      throw err;
    });

    await closeListener();

    return runResult;
  }

  private toArray(): StageResult[] {
    const results: StageResult[] = [];
    for (const stage of this.stages) {
      results.push(this.getStage(stage));
    }

    return results;
  }

  public async stop(): Promise<StageResult[]> {
    if (this.isStageActive) {
      await this.endStage();
    }

    const cluster = await this.getClusterPromise;
    const clusterDir =
      cluster === "unknown"
        ? new URL(this.connection.rpcEndpoint).hostname
        : cluster;

    const dirPath = path.join(
      process.cwd(),
      ".switchboard",
      this.name,
      clusterDir
    );
    fs.mkdirSync(dirPath, { recursive: true });

    const filename = `${this._initTime}.json`;
    const fullFilename = path.join(dirPath, filename);

    const fileString = JSON.stringify(
      {
        timestamp: BNtoDateTimeString(new anchor.BN(this._initTime)),
        cluster: cluster === "unknown" ? undefined : cluster,
        rpcUrl: cluster === "unknown" ? this.connection.rpcEndpoint : undefined,
        config: this.config,
        stages: this.toArray(),
      },
      null,
      2
    );

    fs.writeFileSync(fullFilename, fileString);
    console.log(
      `Receipt file saved to ${path.relative(process.cwd(), fullFilename)}`
    );

    fs.writeFileSync(path.join(dirPath, `latest.json`), fileString);

    return this.toArray();
  }

  public async print(): Promise<void> {
    console.log(JSON.stringify(this.toArray(), null, 2));
  }
}
