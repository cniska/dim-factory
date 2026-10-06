import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { z } from "zod";
import { unreachable } from "./assert";
import { type ConfigRefusal, refuseConfig } from "./config-error";
import { readJsoncText } from "./config-jsonc-file";
import { parseSetting, type SettingDefect } from "./config-setting-file";
import { GATE_NAMES, type GateName, isGateName } from "./gates-contract";
import { committedTree } from "./git-committed";
import { configDir, type Env } from "./paths";

export const SETTINGS = {
  ship: ["default-branch"],
} as const satisfies Record<string, readonly string[]>;

export type Setting = keyof typeof SETTINGS;
export type Config = { [Name in Setting]?: (typeof SETTINGS)[Name][number] };

const model = z.string().trim().min(1).optional();

export const Models = z.strictObject({ default: model, planner: model, builder: model, reviewer: model });
export type Models = z.infer<typeof Models>;

export type UserConfig = Config & { readonly models?: Models };

export const PROJECT_CONFIG = ".dim/config.json";

export function isSetting(name: string): name is Setting {
  return Object.hasOwn(SETTINGS, name);
}

export function userConfigPath(env: Env = process.env): string {
  return join(configDir(env), "config.json");
}

export function projectConfigPath(root: string): string {
  return join(root, PROJECT_CONFIG);
}

function problemOf(defect: SettingDefect): string {
  switch (defect.kind) {
    case "duplicate-key":
      return `names ${defect.keys.join(", ")} twice, so one value silently replaced another`;
    case "not-object":
      return "the config is not an object of settings";
    case "unknown-key":
      return `names ${defect.keys.join(", ")}, which is no setting; the settings are ${Object.keys(SETTINGS).join(", ")}`;
    default:
      return unreachable(defect);
  }
}

function refusal(file: string, defect: SettingDefect): ConfigRefusal {
  return refuseConfig("config_invalid", { path: file, at: null, problem: problemOf(defect) });
}

function allowedValue(file: string, name: Setting, value: unknown): Config[Setting] {
  const allowed = SETTINGS[name].find((one) => one === value);
  if (allowed === undefined) {
    throw refuseConfig("config_invalid", {
      path: file,
      at: name,
      problem: `${name} is ${JSON.stringify(value)}, where it takes one of ${SETTINGS[name].join(", ")}`,
    });
  }
  return allowed;
}

function settingsOf(raw: Record<string, unknown>, file: string): Config {
  const config: Config = {};
  for (const [name, value] of Object.entries(raw)) {
    if (isSetting(name)) config[name] = allowedValue(file, name, value);
  }
  return config;
}

const GATES_KEY = "gates";

type ProjectFile = { readonly config: Config; readonly gates: readonly GateName[] | null };

function parseGates(value: unknown, file: string): readonly GateName[] {
  const parsed = z.array(z.string()).safeParse(value);
  const names = parsed.success ? parsed.data : [];
  if (!parsed.success || !names.every(isGateName) || new Set(names).size !== names.length) {
    throw refuseConfig("config_invalid", {
      path: file,
      at: GATES_KEY,
      problem: `${GATES_KEY} lists each chosen gate once, from ${GATE_NAMES.join(", ")}`,
    });
  }
  return names.filter(isGateName);
}

function parseProjectFile(text: string, file: string): ProjectFile {
  if (text.trim() === "") return { config: {}, gates: null };
  const { [GATES_KEY]: gates, ...settings } = parseSetting(text, file, {
    isKey: (key) => isSetting(key) || key === GATES_KEY,
    refuse: (defect) => refusal(file, defect),
  });
  return { config: settingsOf(settings, file), gates: gates === undefined ? null : parseGates(gates, file) };
}

function parseConfig(text: string, file: string): Config {
  return parseProjectFile(text, file).config;
}

function parseModels(value: unknown, file: string): Models {
  const parsed = Models.safeParse(value);
  if (parsed.success) return parsed.data;
  const roles = Object.keys(Models.shape).join(", ");
  throw refuseConfig("config_invalid", {
    path: file,
    at: "models",
    problem: `models maps ${roles} each to a model name`,
  });
}

function parseUserConfig(text: string, file: string): UserConfig {
  if (text.trim() === "") return {};
  const { models, ...settings } = parseSetting(text, file, {
    isKey: (key) => isSetting(key) || key === "models",
    refuse: (defect) => refusal(file, defect),
  });
  const config = settingsOf(settings, file);
  return models === undefined ? config : { ...config, models: parseModels(models, file) };
}

function committedText(root: string, at: string): string {
  return committedTree(root, at, [PROJECT_CONFIG])?.read(PROJECT_CONFIG) ?? "";
}

export function readUserConfig(env: Env = process.env): UserConfig {
  const path = userConfigPath(env);
  return parseUserConfig(readJsoncText(path), path);
}

export function readProjectConfig(root: string, at?: string): Config {
  const path = projectConfigPath(root);
  return at === undefined
    ? parseConfig(readJsoncText(path), path)
    : parseConfig(committedText(root, at), `${path} as ${at} commits it`);
}

export function readConfig(options: { env?: Env; root?: string; at?: string } = {}): UserConfig {
  const user = readUserConfig(options.env);
  return options.root === undefined ? user : { ...user, ...readProjectConfig(options.root, options.at) };
}

export function readGateChoice(root: string): readonly GateName[] | null {
  const path = projectConfigPath(root);
  return parseProjectFile(readJsoncText(path), path).gates;
}

export function writeGateChoice(root: string, gates: readonly GateName[]): void {
  writeJsonValue(projectConfigPath(root), GATES_KEY, gates);
}

export function writeConfigValue(path: string, name: Setting, value: string | undefined): void {
  if (value !== undefined) allowedValue(path, name, value);
  if (value === undefined && !existsSync(path)) return;
  writeJsonValue(path, name, value);
}

function writeJsonValue(path: string, name: string, value: unknown): void {
  const before = readJsoncText(path);
  parseConfig(before, path);
  const text = before.trim() === "" ? "{}\n" : before;
  const edited = applyEdits(
    text,
    modify(text, [name], value, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, edited.endsWith("\n") ? edited : `${edited}\n`);
}
