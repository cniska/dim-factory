import { GATE_NAMES, type GateName } from "./gates-contract";

export type PickKey = "up" | "down" | "toggle" | "confirm" | "abort" | "none";

export type PickRead = { readonly keys: readonly PickKey[]; readonly partial: string };

const ESCAPE = "\u001b";
const CTRL_C = "\u0003";
const HIDE_CURSOR = `${ESCAPE}[?25l`;
const SHOW_CURSOR = `${ESCAPE}[?25h`;
const CLEAR_LINE = `${ESCAPE}[2K`;
const CURSOR_UP = `${ESCAPE}[A`;
const DIM = (text: string) => `${ESCAPE}[2m${text}${ESCAPE}[22m`;
const SEQUENCE_KEYS: Readonly<Record<string, PickKey>> = { "[A": "up", "[B": "down", OA: "up", OB: "down" };
const SEQUENCE_END = /[A-Za-z~]/;

export const GATE_SUMMARIES: Readonly<Record<GateName, string>> = {
  "commit-subject": "the subject rule at commit and on push",
  check: "the declared check before a commit",
};

export function readPickKeys(chunk: string): PickRead {
  const keys: PickKey[] = [];
  let at = 0;
  while (at < chunk.length) {
    const char = chunk[at];
    if (char === ESCAPE) {
      if (at + 1 === chunk.length) return { keys, partial: chunk.slice(at) };
      if (chunk[at + 1] === "[" || chunk[at + 1] === "O") {
        let end = at + 2;
        while (end < chunk.length && !SEQUENCE_END.test(chunk[end] ?? "")) end += 1;
        if (end === chunk.length) return { keys, partial: chunk.slice(at) };
        keys.push(SEQUENCE_KEYS[chunk.slice(at + 1, end + 1)] ?? "none");
        at = end + 1;
        continue;
      }
      keys.push("none");
      at += 2;
      continue;
    }
    if (char === "\r" || char === "\n") keys.push("confirm");
    else if (char === " ") keys.push("toggle");
    else if (char === CTRL_C) keys.push("abort");
    else keys.push("none");
    at += 1;
  }
  return { keys, partial: "" };
}

export type Picking = { readonly index: number; readonly chosen: ReadonlySet<GateName> };

export function nextPicking({ index, chosen }: Picking, key: PickKey): Picking {
  if (key === "up") return { index: Math.max(0, index - 1), chosen };
  if (key === "down") return { index: Math.min(GATE_NAMES.length - 1, index + 1), chosen };
  if (key !== "toggle") return { index, chosen };
  const gate = GATE_NAMES[index];
  if (gate === undefined) return { index, chosen };
  const next = new Set(chosen);
  if (!next.delete(gate)) next.add(gate);
  return { index, chosen: next };
}

export function pickFrame({ index, chosen }: Picking): string[] {
  return GATE_NAMES.map((gate, row) => {
    const line = `${chosen.has(gate) ? "●" : "○"} ${gate}  ${DIM(GATE_SUMMARIES[gate])}`;
    return row === index ? `❯ ${line}` : `  ${line}`;
  });
}

type PickInput = {
  readonly isTTY?: boolean;
  setRawMode(mode: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  off(event: "data", listener: (chunk: Buffer | string) => void): void;
};

type PickIo = {
  readonly input: PickInput;
  readonly output: { readonly isTTY?: boolean; write(chunk: string): void };
};

export function pickGates(
  io: PickIo = { input: process.stdin, output: process.stderr },
): Promise<GateName[] | null> {
  const { input, output } = io;
  if (!input.isTTY || !output.isTTY) return Promise.resolve(null);
  let picking: Picking = { index: 0, chosen: new Set() };
  const header = DIM("Choose the gates: space toggles, enter confirms");
  const draw = (redraw: boolean) => {
    const frame = [header, ...pickFrame(picking)];
    const prefix = redraw ? CURSOR_UP.repeat(frame.length) : "";
    output.write(`${prefix}${frame.map((row) => `${CLEAR_LINE}${row}\n`).join("")}`);
  };
  return new Promise((resolve) => {
    let carried = "";
    const finish = (value: GateName[] | null) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write(SHOW_CURSOR);
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      const read = readPickKeys(`${carried}${chunk.toString()}`);
      carried = read.partial;
      for (const key of read.keys) {
        if (key === "abort") return finish(null);
        if (key === "confirm") return finish(GATE_NAMES.filter((gate) => picking.chosen.has(gate)));
        picking = nextPicking(picking, key);
      }
      draw(true);
    };
    output.write(HIDE_CURSOR);
    draw(false);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}
