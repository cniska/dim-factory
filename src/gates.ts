import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { readGateChoice, writeGateChoice } from "./config";
import { insertJsoncValue, parseJsonc } from "./config-jsonc";
import { readJsoncText } from "./config-jsonc-file";
import { checkTask } from "./declared-tasks";
import { nextBackupPath } from "./file-backup";
import { GATE_NAMES, type GateName, HOOKS_DIR, PREPARE, refuseGates } from "./gates-contract";
import { configValue, ran } from "./git";

const CANONICAL_DIR = resolve(import.meta.dir, "..", "gates");

export type GateFile = { readonly source: string; readonly target: string; readonly mode: number };

export const GATES: Readonly<Record<GateName, readonly GateFile[]>> = {
  "commit-subject": [
    { source: "commit-msg", target: `${HOOKS_DIR}/commit-msg`, mode: 0o755 },
    { source: "commits.yml", target: ".github/workflows/commits.yml", mode: 0o644 },
  ],
  check: [{ source: "pre-commit", target: `${HOOKS_DIR}/pre-commit`, mode: 0o755 }],
};

export type GateState = "installed" | "missing" | "behind" | "changed" | "ahead" | "unchosen";

export type GatePlan = { readonly gate: GateName; readonly target: string; readonly state: GateState };

export type GatesInstalled = {
  readonly gates: readonly GateName[];
  readonly written: readonly string[];
  readonly removed: readonly string[];
  readonly backups: readonly string[];
};

const MARKER = /dim-gate:(\d+)/;

function versionOf(text: string): number | null {
  const found = text.match(MARKER)?.[1];
  return found === undefined ? null : Number(found);
}

export function canonicalSource(file: GateFile): string {
  return readFileSync(join(CANONICAL_DIR, file.source), "utf8");
}

function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function stateOf(canonical: string, installed: string | null): GateState {
  if (installed === null) return "missing";
  if (installed === canonical) return "installed";
  const at = versionOf(installed);
  const wanted = versionOf(canonical);
  if (at === null || at === wanted) return "changed";
  return wanted !== null && at < wanted ? "behind" : "ahead";
}

function rendered(root: string, file: GateFile): string {
  const source = canonicalSource(file);
  if (!source.includes("{{check}}")) return source;
  const check = checkTask(root);
  if (check === null) throw refuseGates("no_check", { root });
  return source.replaceAll("{{check}}", check.commandLine);
}

type Planned = GatePlan & { readonly file: GateFile; readonly path: string; readonly text: string };

function planned(root: string, chosen: readonly GateName[]): Planned[] {
  return GATE_NAMES.flatMap((gate) =>
    GATES[gate].flatMap((file): Planned[] => {
      const path = join(root, file.target);
      const found = readOrNull(path);
      if (!chosen.includes(gate)) {
        return found !== null && MARKER.test(found)
          ? [{ gate, target: file.target, state: "unchosen", file, path, text: "" }]
          : [];
      }
      const text = rendered(root, file);
      return [{ gate, target: file.target, state: stateOf(text, found), file, path, text }];
    }),
  );
}

export function planGates(root: string, chosen: readonly GateName[]): GatePlan[] {
  return planned(root, chosen).map(({ gate, target, state }) => ({ gate, target, state }));
}

const PackageScripts = z.looseObject({
  scripts: z.looseObject({ prepare: z.string().optional() }).optional(),
});

function prepareWiring(root: string): string | null {
  const path = join(root, "package.json");
  const text = readJsoncText(path);
  if (text === "") return null;
  const prepare = parseJsonc(text, path, PackageScripts).scripts?.prepare;
  if (prepare === PREPARE) return null;
  if (prepare !== undefined) throw refuseGates("prepare_occupied", { path, prepare });
  return insertJsoncValue(text, ["scripts", "prepare"], PREPARE);
}

export function hooksWired(root: string): boolean {
  return configValue(root, "core.hooksPath") === HOOKS_DIR;
}

export function runsHooks(chosen: readonly GateName[]): boolean {
  return chosen.some((gate) => GATES[gate].some((file) => file.target.startsWith(`${HOOKS_DIR}/`)));
}

function checkHooksPath(root: string): void {
  const hooksPath = configValue(root, "core.hooksPath");
  if (hooksPath !== null && hooksPath !== HOOKS_DIR)
    throw refuseGates("hooks_path_occupied", { root, hooksPath });
}

export function installGates(root: string, choice: readonly GateName[] | null): GatesInstalled {
  const chosen = choice ?? readGateChoice(root);
  if (chosen === null) throw refuseGates("no_gates_chosen", { root });
  const hooks = runsHooks(chosen);
  if (hooks) checkHooksPath(root);
  const packageJson = hooks ? prepareWiring(root) : null;
  const plans = planned(root, chosen);
  if (choice !== null) writeGateChoice(root, choice);
  const written: string[] = [];
  const removed: string[] = [];
  const backups: string[] = [];
  for (const { file, path, text, state } of plans) {
    if (state === "installed" || state === "ahead") continue;
    if (state === "unchosen") {
      rmSync(path);
      removed.push(file.target);
      continue;
    }
    if (state === "changed") {
      const backup = nextBackupPath(path);
      renameSync(path, backup);
      backups.push(relative(root, backup));
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    chmodSync(path, file.mode);
    written.push(file.target);
  }
  if (packageJson !== null) writeFileSync(join(root, "package.json"), packageJson);
  if (hooks) ran(root, ["config", "core.hooksPath", HOOKS_DIR]);
  return { gates: chosen, written, removed, backups };
}
