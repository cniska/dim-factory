import { UsageError } from "./cli-contract";
import {
  projectConfigPath,
  readProjectConfig,
  readUserConfig,
  userConfigPath,
  writeConfigValue,
} from "./config";
import { type Layer, SETTING_KEYS } from "./config-contract";
import { checkoutRoot } from "./git-checkout";
import type { Env } from "./paths";

const SETTINGS_LISTED = Object.fromEntries(
  Object.entries(SETTING_KEYS).map(([key, { layers }]) => [key, layers]),
);

export function configLayers(cwd: string, env: Env) {
  const root = checkoutRoot(cwd);
  const user = readUserConfig(env);
  if (root === null) {
    return {
      user: { path: userConfigPath(env), config: user },
      project: null,
      resolved: user,
      settings: SETTINGS_LISTED,
    };
  }
  const committed = readProjectConfig(root, "HEAD");
  return {
    user: { path: userConfigPath(env), config: user },
    project: { path: projectConfigPath(root), config: readProjectConfig(root), committed },
    resolved: { ...user, ...committed },
    settings: SETTINGS_LISTED,
  };
}

export type SettingChange = {
  readonly key: string;
  readonly value: string | undefined;
  readonly layer: Layer;
};

export function changeSetting(cwd: string, env: Env, change: SettingChange) {
  const root = change.layer === "project" ? checkoutRoot(cwd) : null;
  if (change.layer === "project" && root === null) {
    throw new UsageError(`${cwd} is not inside a git checkout, so it has no project config`);
  }
  const path = root === null ? userConfigPath(env) : projectConfigPath(root);
  writeConfigValue(path, change.layer, change.key, change.value);
  return configLayers(cwd, env);
}
