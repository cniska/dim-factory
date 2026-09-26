import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { ConfigError } from "./config-error";
import { readJsoncText } from "./config-jsonc-file";
import { parseSetting, type SettingDefect } from "./config-setting-file";
import { type Env, resolveHomeDir } from "./paths";

export const SETTINGS = {
  comments: ["banned", "allowed"],
} as const satisfies Record<string, readonly string[]>;

export type Setting = keyof typeof SETTINGS;
export type Config = { [Name in Setting]?: (typeof SETTINGS)[Name][number] };

export const PROJECT_CONFIG = ".dim/config.json";

export function isSetting(name: string): name is Setting {
  return Object.hasOwn(SETTINGS, name);
}

export function userConfigPath(env: Env = process.env): string {
  return join(resolveHomeDir(env), ".config", "dim", "config.json");
}

export function projectConfigPath(root: string): string {
  return join(root, PROJECT_CONFIG);
}

function refusal(file: string, defect: SettingDefect): ConfigError {
  const known = Object.keys(SETTINGS).join(", ");
  const message =
    defect.kind === "duplicate-key"
      ? `${file}: names ${defect.keys.join(", ")} twice, so one value silently replaced another`
      : defect.kind === "not-object"
        ? `${file}: the config is not an object of settings`
        : `${file}: names ${defect.keys.join(", ")}, which is no setting; the settings are ${known}`;
  return new ConfigError("invalid", file, message);
}

function refuseValue(file: string, name: Setting, value: unknown): void {
  const allowed: readonly string[] = SETTINGS[name];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ConfigError(
      "invalid",
      file,
      `${file}: ${name} is ${JSON.stringify(value)}, where it takes one of ${allowed.join(", ")}`,
      name,
    );
  }
}

function parseConfig(text: string, file: string): Config {
  if (text.trim() === "") return {};
  const raw = parseSetting(text, file, { isKey: isSetting, refuse: (defect) => refusal(file, defect) });
  for (const [name, value] of Object.entries(raw)) refuseValue(file, name as Setting, value);
  return raw as Config;
}

function committedText(root: string, at: string): string {
  const git = (args: string[]) => {
    const run = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: run.status, out: run.stdout, err: run.stderr.trim() };
  };
  const commit = git(["rev-parse", "--verify", "-q", `${at}^{commit}`]);
  if (commit.status === 1) return "";
  if (commit.status !== 0) throw new Error(`cannot read ${at} in ${root}: ${commit.err}`);
  const listed = git(["ls-tree", "--name-only", at, "--", PROJECT_CONFIG]);
  if (listed.status !== 0)
    throw new Error(`cannot list ${PROJECT_CONFIG} at ${at} in ${root}: ${listed.err}`);
  if (listed.out.trim() === "") return "";
  const shown = git(["show", `${at}:${PROJECT_CONFIG}`]);
  if (shown.status !== 0) throw new Error(`cannot read ${PROJECT_CONFIG} at ${at} in ${root}: ${shown.err}`);
  return shown.out;
}

export function readUserConfig(env: Env = process.env): Config {
  const path = userConfigPath(env);
  return parseConfig(readJsoncText(path), path);
}

export function readProjectConfig(root: string, at?: string): Config {
  const path = projectConfigPath(root);
  return at === undefined
    ? parseConfig(readJsoncText(path), path)
    : parseConfig(committedText(root, at), `${path} as ${at} commits it`);
}

export function readConfig(options: { env?: Env; root?: string; at?: string } = {}): Config {
  const user = readUserConfig(options.env);
  return options.root === undefined ? user : { ...user, ...readProjectConfig(options.root, options.at) };
}

export function writeConfigValue(path: string, name: Setting, value: string | undefined): void {
  if (value !== undefined) refuseValue(path, name, value);
  const before = readJsoncText(path);
  parseConfig(before, path);
  if (value === undefined && !existsSync(path)) return;
  const text = before.trim() === "" ? "{}\n" : before;
  const edited = applyEdits(
    text,
    modify(text, [name], value, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, edited.endsWith("\n") ? edited : `${edited}\n`);
}
