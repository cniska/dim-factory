import { type Command, UsageError } from "./cli-contract";
import { parseArgs } from "./cli-flags";
import { isSettingKey, SETTING_KEYS } from "./config-contract";
import { changeSetting, configLayers } from "./config-ops";
import type { Env } from "./paths";

const USAGE =
  "usage: dim config | dim config set <setting> <value> [--project] | dim config unset <setting> [--project]";

export function runConfig(args: string[], cwd = process.cwd(), env: Env = process.env): unknown {
  const { positionals, switches } = parseArgs(
    args,
    { positionals: [0, 3], flags: [], switches: ["project"] },
    "dim config",
  );
  const project = switches.has("project");
  const [verb, name, ...rest] = positionals;
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
  if (!isSettingKey(name)) {
    throw new UsageError(`${name} is no setting; the settings are ${Object.keys(SETTING_KEYS).join(", ")}`);
  }
  return changeSetting(cwd, env, { key: name, value, layer: project ? "project" : "user" });
}

export const configCommand: Command = {
  name: "config",
  usage: USAGE,
  summary: "print the user and project config, or change one setting in either",
  run: (args) => runConfig(args),
};
