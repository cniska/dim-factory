import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { insertJsoncValue, parseJsonc } from "./config-jsonc";
import { readJsoncText } from "./config-jsonc-file";
import { checkTask } from "./declared-tasks";
import { nextBackupPath } from "./file-backup";
import { HOOKS_DIR, PREPARE, refuseGates } from "./gates-contract";
import { configValue, ran } from "./git";

const CANONICAL_DIR = resolve(import.meta.dir, "..", "gates");

export type Gate = {
  readonly name: string;
  readonly source: string;
  readonly target: string;
  readonly mode: number;
};

export const GATES: readonly Gate[] = [
  { name: "commit-msg", source: "commit-msg", target: `${HOOKS_DIR}/commit-msg`, mode: 0o755 },
  { name: "commits", source: "commits.yml", target: ".github/workflows/commits.yml", mode: 0o644 },
  { name: "pre-commit", source: "pre-commit", target: `${HOOKS_DIR}/pre-commit`, mode: 0o755 },
];

export type GateState = "installed" | "missing" | "behind" | "changed" | "ahead";

export type GatePlan = { readonly name: string; readonly target: string; readonly state: GateState };

export type GatesInstalled = { readonly written: readonly string[]; readonly backups: readonly string[] };

function versionOf(text: string): number | null {
  const found = text.match(/dim-gate:(\d+)/)?.[1];
  return found === undefined ? null : Number(found);
}

export function canonicalSource(gate: Gate): string {
  return readFileSync(join(CANONICAL_DIR, gate.source), "utf8");
}

type Planned = {
  readonly gate: Gate;
  readonly path: string;
  readonly text: string;
  readonly state: GateState;
};

function planned(root: string): Planned[] {
  const check = checkTask(root);
  if (check === null) throw refuseGates("no_check", { root });
  return GATES.map((gate) => {
    const path = join(root, gate.target);
    const text = canonicalSource(gate).replaceAll("{{check}}", check.commandLine);
    return { gate, path, text, state: stateOf(text, readOrNull(path)) };
  });
}

function stateOf(canonical: string, installed: string | null): GateState {
  if (installed === null) return "missing";
  if (installed === canonical) return "installed";
  const at = versionOf(installed);
  const wanted = versionOf(canonical);
  if (at === null || at === wanted) return "changed";
  return wanted !== null && at < wanted ? "behind" : "ahead";
}

function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function planGates(root: string): GatePlan[] {
  return planned(root).map(({ gate, state }) => ({ name: gate.name, target: gate.target, state }));
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

function checkHooksPath(root: string): void {
  const hooksPath = configValue(root, "core.hooksPath");
  if (hooksPath !== null && hooksPath !== HOOKS_DIR)
    throw refuseGates("hooks_path_occupied", { root, hooksPath });
}

export function installGates(root: string): GatesInstalled {
  checkHooksPath(root);
  const packageJson = prepareWiring(root);
  const plans = planned(root);
  const written: string[] = [];
  const backups: string[] = [];
  for (const { gate, path, text, state } of plans) {
    if (state === "installed" || state === "ahead") continue;
    if (state === "changed") {
      const backup = nextBackupPath(path);
      renameSync(path, backup);
      backups.push(relative(root, backup));
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    chmodSync(path, gate.mode);
    written.push(gate.target);
  }
  if (packageJson !== null) writeFileSync(join(root, "package.json"), packageJson);
  ran(root, ["config", "core.hooksPath", HOOKS_DIR]);
  return { written, backups };
}
