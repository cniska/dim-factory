import { basename } from "node:path";
import { trackedFiles } from "./comments-files";

export type Lock = { readonly lock: string; readonly manager: string; readonly install: string };

type EcosystemFiles = { readonly manifests: readonly string[]; readonly locks: readonly Lock[] };

export const ECOSYSTEMS = {
  javascript: {
    manifests: ["package.json", "deno.json", "deno.jsonc"],
    locks: [
      { lock: "bun.lock", manager: "bun", install: "bun install --frozen-lockfile --ignore-scripts" },
      { lock: "bun.lockb", manager: "bun", install: "bun install --frozen-lockfile --ignore-scripts" },
      { lock: "pnpm-lock.yaml", manager: "pnpm", install: "pnpm install --frozen-lockfile --ignore-scripts" },
      { lock: "yarn.lock", manager: "yarn", install: "yarn install --frozen-lockfile --ignore-scripts" },
      { lock: "package-lock.json", manager: "npm", install: "npm ci --ignore-scripts" },
    ],
  },
} as const satisfies Record<string, EcosystemFiles>;

export type Ecosystem = keyof typeof ECOSYSTEMS;

const ECOSYSTEM_NAMES = Object.keys(ECOSYSTEMS).filter((name): name is Ecosystem =>
  Object.hasOwn(ECOSYSTEMS, name),
);

export const LOCKS: readonly Lock[] = ECOSYSTEM_NAMES.flatMap((name) => ECOSYSTEMS[name].locks);

export function ecosystemsOf(root: string): Ecosystem[] {
  const tracked = new Set(trackedFiles(root, []).map((path) => basename(path)));
  return ECOSYSTEM_NAMES.filter((name) => {
    const { manifests, locks } = ECOSYSTEMS[name];
    return manifests.some((file) => tracked.has(file)) || locks.some(({ lock }) => tracked.has(lock));
  });
}
