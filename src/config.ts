import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree } from "jsonc-parser";
import { z } from "zod";
import { unreachable } from "./assert";
import {
  type Config,
  LAYER_SECTIONS,
  type Layer,
  Models,
  SETTING_KEYS,
  SHIP_WAYS,
  Tasks,
  type UserConfig,
} from "./config-contract";
import { type ConfigRefusal, invalidConfig, refuseConfig } from "./config-error";
import { readJsoncText } from "./config-jsonc-file";
import { parseSetting, type SettingDefect } from "./config-setting-file";
import { GATE_NAMES, type GateName, isGateName } from "./gates-contract";
import { committedTree } from "./git-committed";
import { configDir, type Env } from "./paths";

export const PROJECT_CONFIG = ".dim/config.json";

const GATES_KEY = "gates";

export function userConfigPath(env: Env = process.env): string {
  return join(configDir(env), "config.json");
}

export function projectConfigPath(root: string): string {
  return join(root, PROJECT_CONFIG);
}

function problemOf(defect: SettingDefect, layer: Layer): string {
  switch (defect.kind) {
    case "duplicate-key":
      return `names ${defect.keys.join(", ")} twice, so one value silently replaced another`;
    case "not-object":
      return "the config is not an object of settings";
    case "unknown-key":
      return `names ${defect.keys.join(", ")}, which is no ${layer} setting; the ${layer} settings are ${LAYER_SECTIONS[layer].join(", ")}`;
    default:
      return unreachable(defect);
  }
}

function layerFields(text: string, file: string, layer: Layer): Record<string, unknown> {
  if (text.trim() === "") return {};
  return parseSetting(text, file, {
    isKey: (key) => LAYER_SECTIONS[layer].includes(key),
    refuse: (defect): ConfigRefusal =>
      refuseConfig("config_invalid", { path: file, at: null, problem: problemOf(defect, layer) }),
  });
}

function parsed<S extends z.ZodType>(section: string, schema: S, value: unknown, file: string): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({ ...issue, path: [section, ...issue.path] }));
  throw invalidConfig(file, new z.ZodError(issues));
}

const Ship = z.enum(SHIP_WAYS);

function configOf(fields: Record<string, unknown>, file: string): Config {
  return {
    ...(fields.ship === undefined ? {} : { ship: parsed("ship", Ship, fields.ship, file) }),
    ...(fields.tasks === undefined ? {} : { tasks: parsed("tasks", Tasks, fields.tasks, file) }),
  };
}

function parseGates(value: unknown, file: string): readonly GateName[] {
  const names = z.array(z.string()).safeParse(value);
  const listed = names.success ? names.data : [];
  if (!names.success || !listed.every(isGateName) || new Set(listed).size !== listed.length) {
    throw refuseConfig("config_invalid", {
      path: file,
      at: GATES_KEY,
      problem: `${GATES_KEY} lists each chosen gate once, from ${GATE_NAMES.join(", ")}`,
    });
  }
  return listed.filter(isGateName);
}

export function parseConfig(text: string, file: string): Config {
  return configOf(layerFields(text, file, "project"), file);
}

function parseUserConfig(text: string, file: string): UserConfig {
  const fields = layerFields(text, file, "user");
  const config = configOf(fields, file);
  return fields.models === undefined
    ? config
    : { ...config, models: parsed("models", Models, fields.models, file) };
}

function parseLayer(text: string, file: string, layer: Layer): void {
  if (layer === "user") {
    parseUserConfig(text, file);
    return;
  }
  const fields = layerFields(text, file, "project");
  configOf(fields, file);
  if (fields[GATES_KEY] !== undefined) parseGates(fields[GATES_KEY], file);
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
  const gates = layerFields(readJsoncText(path), path, "project")[GATES_KEY];
  return gates === undefined ? null : parseGates(gates, path);
}

export function writeGateChoice(root: string, gates: readonly GateName[]): boolean {
  return writeJsonValue(projectConfigPath(root), "project", [GATES_KEY], gates);
}

function sectionOf(path: string, layer: Layer, section: string): object {
  const value = layerFields(readJsoncText(path), path, layer)[section];
  return typeof value === "object" && value !== null ? value : {};
}

export function writeConfigValue(
  path: string,
  layer: Layer,
  key: string,
  value: string | undefined,
): boolean {
  const setting = SETTING_KEYS[key];
  if (setting === undefined) {
    throw refuseConfig("config_invalid", {
      path,
      at: key,
      problem: `${key} is no setting; the settings are ${Object.keys(SETTING_KEYS).join(", ")}`,
    });
  }
  if (!setting.layers.includes(layer)) {
    throw refuseConfig("config_invalid", {
      path,
      at: key,
      problem: `${key} is a ${setting.layers.join(" and ")} setting, so it is set ${layer === "user" ? "with --project in that project" : "without --project"}`,
    });
  }
  if (value !== undefined) {
    const checked = setting.schema.safeParse(value);
    if (!checked.success) {
      throw refuseConfig("config_invalid", {
        path,
        at: key,
        problem: `${key} is ${JSON.stringify(value)}: ${z.prettifyError(checked.error)}`,
      });
    }
  }
  const keys = key.split(".");
  const [section, entry] = keys;
  const emptied =
    value === undefined &&
    section !== undefined &&
    entry !== undefined &&
    Object.keys(sectionOf(path, layer, section)).every((name) => name === entry);
  return writeJsonValue(path, layer, emptied ? [section] : keys, value);
}

function valueAt(text: string, keys: readonly string[]): unknown {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const node = root && findNodeAtLocation(root, [...keys]);
  return node === undefined ? undefined : getNodeValue(node);
}

function writeJsonValue(path: string, layer: Layer, keys: readonly string[], value: unknown): boolean {
  const before = readJsoncText(path);
  parseLayer(before, path, layer);
  if (JSON.stringify(valueAt(before, keys)) === JSON.stringify(value)) return false;
  const text = before.trim() === "" ? "{}\n" : before;
  const edited = applyEdits(
    text,
    modify(text, [...keys], value, { formattingOptions: { tabSize: 2, insertSpaces: true } }),
  );
  const written = edited.endsWith("\n") ? edited : `${edited}\n`;
  parseLayer(written, path, layer);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, written);
  return true;
}
