import { type Command, UsageError } from "./cli-contract";
import { isSetting, SETTINGS } from "./config";
import { changeSetting, configLayers } from "./config-ops";
import type { Env } from "./paths";

const USAGE =
  "usage: dim config | dim config set <setting> <value> [--project] | dim config unset <setting> [--project]";

export function runConfig(args: string[], cwd = process.cwd(), env: Env = process.env): unknown {
  const project = args.includes("--project");
  const [verb, name, ...rest] = args.filter((arg) => arg !== "--project");
  if (verb === undefined) {
    if (project) throw new UsageError("--project names the layer to change, so it goes with set or unset");
    return configLayers(cwd, env);
  }
  const [value, ...extra] = rest;
  const wellFormed =
    name !== undefined &&
    extra.length === 0 &&
    ((verb === "set" && value !== undefined) || (verb === "unset" && value === undefined));
  if (!wellFormed) throw new UsageError(`${args.join(" ")} is not a config command`);
  if (!isSetting(name)) {
    throw new UsageError(`${name} is no setting; the settings are ${Object.keys(SETTINGS).join(", ")}`);
  }
  return changeSetting(cwd, env, { name, value, layer: project ? "project" : "user" });
}

export const configCommand: Command = {
  name: "config",
  usage: USAGE,
  summary: "print the user and project config, or change one setting in either",
  run: (args) => runConfig(args),
};
