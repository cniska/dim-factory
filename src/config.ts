import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import { z } from "zod";
import { ConfigError } from "./config-error";
import { readJsoncText } from "./config-jsonc-file";
import { parseSetting, type SettingDefect } from "./config-setting-file";
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

function settingsOf(raw: Record<string, unknown>, file: string): Config {
  for (const [name, value] of Object.entries(raw)) refuseValue(file, name as Setting, value);
  return raw as Config;
}

function parseConfig(text: string, file: string): Config {
  if (text.trim() === "") return {};
  return settingsOf(
    parseSetting(text, file, { isKey: isSetting, refuse: (defect) => refusal(file, defect) }),
    file,
  );
}

function parseModels(value: unknown, file: string): Models {
  const parsed = Models.safeParse(value);
  if (parsed.success) return parsed.data;
  const roles = Object.keys(Models.shape).join(", ");
  throw new ConfigError("invalid", file, `${file}: models maps ${roles} each to a model name`, "models");
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
