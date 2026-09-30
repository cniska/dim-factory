import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { hookCommands, userHooks } from "./claude-hooks";

export type Ran = { exitCode: number; stdout: string; stderr: string };

export type Refusal = { code: string; message: string; meta?: Record<string, unknown> };

export type DimResult = { ok: boolean; result: unknown; error?: Refusal; ran: Ran };

const quote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

export function parseDim(ran: Ran): DimResult {
  const line = (ran.exitCode === 0 ? ran.stdout : ran.stderr || ran.stdout).trim().split("\n").at(-1) ?? "";
  let parsed: { ok?: boolean; result?: unknown; error?: Refusal };
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`dim printed no structured result (exit ${ran.exitCode}):\n${ran.stdout}\n${ran.stderr}`);
  }
  return { ok: parsed.ok === true, result: parsed.result, error: parsed.error, ran };
}

export class OperatorSession {
  readonly sessionId = `operator-${crypto.randomUUID()}`;
  private calls = 0;

  private constructor(
    private readonly shell: Subprocess<"pipe", "ignore", "ignore">,
    private readonly scratch: string,
    readonly env: Record<string, string>,
    readonly cwd: string,
  ) {}

  static async open(env: Record<string, string>, cwd: string): Promise<OperatorSession> {
    const scratch = mkdtempSync(join(env.TMPDIR as string, "dim-operator-"));
    const shell = Bun.spawn(["sh"], { cwd, env, stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    return new OperatorSession(shell, scratch, env, cwd);
  }

  get pid(): number {
    return this.shell.pid;
  }

  async sh(command: string, stdin = ""): Promise<Ran> {
    const call = join(this.scratch, String(++this.calls));
    await Bun.write(`${call}.in`, stdin);
    this.shell.stdin.write(
      `{ ${command}; } < ${quote(`${call}.in`)} > ${quote(`${call}.out`)} 2> ${quote(`${call}.err`)}; echo $? > ${quote(`${call}.tmp`)}; mv ${quote(`${call}.tmp`)} ${quote(`${call}.done`)}\n`,
    );
    this.shell.stdin.flush();
    while (!existsSync(`${call}.done`)) await Bun.sleep(10);
    return {
      exitCode: Number(readFileSync(`${call}.done`, "utf8").trim()),
      stdout: readFileSync(`${call}.out`, "utf8"),
      stderr: readFileSync(`${call}.err`, "utf8"),
    };
  }

  async dim(args: string[]): Promise<DimResult> {
    return parseDim(await this.sh(["dim", ...args].map(quote).join(" ")));
  }

  async dimIn(cwd: string, args: string[]): Promise<DimResult> {
    return parseDim(await this.sh(`(cd ${quote(cwd)} && exec ${["dim", ...args].map(quote).join(" ")})`));
  }

  async dimOk(args: string[]): Promise<unknown> {
    const ran = await this.dim(args);
    if (!ran.ok) throw new Error(`dim ${args.join(" ")} refused: ${JSON.stringify(ran.error)}`);
    return ran.result;
  }

  async fire(event: "SessionStart" | "SessionEnd"): Promise<void> {
    const payload = JSON.stringify({
      session_id: this.sessionId,
      hook_event_name: event,
      source: "startup",
      cwd: this.cwd,
    });
    for (const command of hookCommands(userHooks(this.env.HOME as string), event)) {
      await this.sh(`sh -c ${quote(command)}`, payload);
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
