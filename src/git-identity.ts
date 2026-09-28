import type { Env } from "./paths";

const IDENTITY_OVERRIDES = new Set([
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE",
  "EMAIL",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
]);

function overridesRepoIdentity(name: string): boolean {
  return IDENTITY_OVERRIDES.has(name) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name);
}

export function repoIdentityEnv(env: Env = process.env): Env {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !overridesRepoIdentity(name)));
}
