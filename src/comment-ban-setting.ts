import { join } from "node:path";
import { ConfigError } from "./config-error";
import { dataDir, type Env } from "./paths";
import { readSettingFile } from "./setting-file";

const EVERY_REPO = "all";

const TEMPLATE = `{ "repos": ["<owner>/<repo>"] } or { "repos": "${EVERY_REPO}" }`;

export function commentBanPath(env: Env = process.env): string {
  return join(dataDir(env), "comment-gate.json");
}

export function commentsBanned(label: string, env: Env = process.env): boolean {
  const path = commentBanPath(env);
  const refuse = (message: string) => new ConfigError("invalid", path, message);
  const setting = readSettingFile(path, {
    isKey: (key) => key === "repos",
    refuse: (defect) =>
      refuse(
        defect.kind === "duplicate-key"
          ? `${path}: names ${defect.keys.join(", ")} twice, so one value silently replaced another`
          : defect.kind === "not-object"
            ? `${path}: the setting is not an object of ${TEMPLATE}`
            : `${path}: names ${defect.keys.join(", ")}, which is no setting; write ${TEMPLATE}`,
      ),
  });
  const repos = setting?.repos;
  if (repos === undefined) return false;
  if (repos === EVERY_REPO) return true;
  if (
    !Array.isArray(repos) ||
    !repos.every((r) => typeof r === "string" && /^[^/\s]+(?:\/[^/\s]+)+$/.test(r.trim()))
  ) {
    throw refuse(`${path}: repos is neither "${EVERY_REPO}" nor a list of owner/repo labels`);
  }
  return repos.some((r: string) => r.trim().toLowerCase() === label.toLowerCase());
}
