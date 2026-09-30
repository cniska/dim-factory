import { UsageError } from "./cli-contract";
import {
  projectConfigPath,
  readProjectConfig,
  readUserConfig,
  SETTINGS,
  type Setting,
  userConfigPath,
  writeConfigValue,
} from "./config";
import { checkoutRoot } from "./git-checkout";
import type { Env } from "./paths";

export function configLayers(cwd: string, env: Env) {
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

export type SettingChange = {
  readonly name: Setting;
  readonly value: string | undefined;
  readonly layer: "user" | "project";
};

export function changeSetting(cwd: string, env: Env, change: SettingChange) {
  const root = change.layer === "project" ? checkoutRoot(cwd) : null;
  if (change.layer === "project" && root === null) {
    throw new UsageError(`${cwd} is not inside a git checkout, so it has no project config`);
  }
  writeConfigValue(root === null ? userConfigPath(env) : projectConfigPath(root), change.name, change.value);
  return configLayers(cwd, env);
}
