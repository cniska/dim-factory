import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { hookCommands, settingsHooks } from "./claude-hooks";
import { commandLine, type DimResult, parseDim, quote, type Ran } from "./dim-output";
import type { MachineEnv } from "./machine";
import { waitFor } from "./wait";

export class OperatorSession {
  readonly sessionId = crypto.randomUUID();
  private calls = 0;

  private constructor(
    private readonly shell: Subprocess<"pipe", "ignore", "ignore">,
    private readonly scratch: string,
    readonly env: MachineEnv,
    readonly cwd: string,
  ) {}

  static open(env: MachineEnv, cwd: string): OperatorSession {
    const scratch = mkdtempSync(join(env.TMPDIR, "dim-operator-"));
    const shell = Bun.spawn(["sh"], { cwd, env, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    return new OperatorSession(shell, scratch, env, cwd);
  }

  get pid(): number {
    return this.shell.pid;
  }

  async sh(command: string, stdin = "", { alongside = true } = {}): Promise<Ran> {
    const call = join(this.scratch, String(++this.calls));
    await Bun.write(`${call}.in`, stdin);
    const [input, out, err, tmp, done] = ["in", "out", "err", "tmp", "done"].map((part) =>
      quote(`${call}.${part}`),
    );
    const ran = `{ ${command}; } < ${input} > ${out} 2> ${err}; echo $? > ${tmp}; mv ${tmp} ${done}`;
    this.shell.stdin.write(alongside ? `{ ${ran}; } &\n` : `${ran}\n`);
    this.shell.stdin.flush();
    await waitFor(`\`${command}\` to finish`, () => existsSync(`${call}.done`));
    return {
      exitCode: Number(readFileSync(`${call}.done`, "utf8").trim()),
      stdout: readFileSync(`${call}.out`, "utf8"),
      stderr: readFileSync(`${call}.err`, "utf8"),
    };
  }

  async dim(args: readonly string[]): Promise<DimResult> {
    return parseDim(await this.sh(commandLine(args)));
  }

  async dimIn(cwd: string, args: readonly string[]): Promise<DimResult> {
    return parseDim(await this.sh(`(cd ${quote(cwd)} && exec ${commandLine(args)})`));
  }

  async fire(event: "SessionStart" | "SessionEnd"): Promise<void> {
    const payload = JSON.stringify({
      session_id: this.sessionId,
      hook_event_name: event,
      source: "startup",
      cwd: this.cwd,
    });
    for (const command of hookCommands(settingsHooks(this.env.HOME), event)) {
      await this.sh(`sh -c ${quote(command)}`, payload, { alongside: false });
    }
  }

  async register(): Promise<DimResult> {
    await this.fire("SessionStart");
    return this.dim(["operator", "register"]);
  }

  close(): void {
    this.shell.kill("SIGKILL");
    rmSync(this.scratch, { recursive: true, force: true });
  }
}
