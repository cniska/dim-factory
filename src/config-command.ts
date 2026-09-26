import { checkoutRoot } from "./checkout";
import { type Command, UsageError } from "./command";
import {
  isSetting,
  projectConfigPath,
  readProjectConfig,
  readUserConfig,
  SETTINGS,
  userConfigPath,
  writeConfigValue,
} from "./config";
import type { Env } from "./paths";

const USAGE =
  "usage: dim config | dim config set <setting> <value> [--project] | dim config unset <setting> [--project]";

function layers(cwd: string, env: Env) {
  const root = checkoutRoot(cwd);
  const user = readUserConfig(env);
  if (root === null) {
    return {
      user: { path: userConfigPath(env), config: user },
      project: null,
      resolved: user,
      settings: SETTINGS,
    };
  }
  const committed = readProjectConfig(root, "HEAD");
  return {
    user: { path: userConfigPath(env), config: user },
    project: { path: projectConfigPath(root), config: readProjectConfig(root), committed },
    resolved: { ...user, ...committed },
    settings: SETTINGS,
  };
}

export function runConfig(args: string[], cwd = process.cwd(), env: Env = process.env): unknown {
  const project = args.includes("--project");
  const [verb, name, ...rest] = args.filter((arg) => arg !== "--project");
  if (verb === undefined) {
    if (project) throw new UsageError("--project names the layer to change, so it goes with set or unset");
    return layers(cwd, env);
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
  const root = project ? checkoutRoot(cwd) : null;
  if (project && root === null)
    throw new Error(`${cwd} is not inside a git checkout, so it has no project config`);
  writeConfigValue(root === null ? userConfigPath(env) : projectConfigPath(root), name, value);
  return layers(cwd, env);
}

export const configCommand: Command = {
  name: "config",
  usage: USAGE,
  summary: "print the user and project config, or change one setting in either",
  run: (args) => runConfig(args),
};
