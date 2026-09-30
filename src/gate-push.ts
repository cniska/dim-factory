import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fail, GATE_ERROR, type Gate, type GateInput } from "./gate-contract";
import { remoteSlug } from "./git-remote-slug";
import { git } from "./git-tree";

const PREFIX = "pre-push: ";

export function unarmedCheckouts(dirs: readonly string[]): readonly string[] {
  return dirs.filter(
    (dir) =>
      git(dir, ["config", "--get", "remote.origin.url"]).ok &&
      !git(dir, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]).ok,
  );
}

type Target = { readonly remote: string; readonly url: string };

type Update = {
  readonly local: string;
  readonly remoteRef: string;
  readonly remoteOid: string;
  readonly fetched: boolean;
  readonly reverts: readonly string[];
  readonly fastForward: boolean;
};

const ABSENT = /^0+$/;

function normalizedUrl(url: string, cwd: string): string {
  const trimmed = (url.startsWith("file://") ? url.slice("file://".length) : url).replace(/\/$/, "");
  const local = resolve(cwd, trimmed);
  return existsSync(local) && statSync(local).isDirectory() ? local : trimmed;
}

function target({ args, cwd }: GateInput): Target | null {
  const [remote, url] = args;
  if (remote === undefined || url === undefined || url === "") return null;
  return { remote, url: normalizedUrl(url, cwd) };
}

function pushedRemote({ remote, url }: Target, cwd: string): string | null {
  if (git(cwd, ["config", "--get", `remote.${remote}.url`]).ok) return remote;
  const matches = git(cwd, ["remote"])
    .out.split("\n")
    .filter(
      (name) =>
        name !== "" && normalizedUrl(git(cwd, ["remote", "get-url", "--push", name]).out, cwd) === url,
    );
  const named = matches.find((name) => git(cwd, ["symbolic-ref", "-q", `refs/remotes/${name}/HEAD`]).ok);
  return named ?? matches.at(-1) ?? null;
}

function sharedBranch(remote: string, cwd: string): string | null {
  const head = git(cwd, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`]).out;
  if (head === "") return null;
  const branch = head.startsWith(`${remote}/`) ? head.slice(remote.length + 1) : head;
  return `refs/heads/${branch}`;
}

function updateOf(line: string, remote: string, cwd: string): Update {
  const fields = line.split(" ");
  const [, local, remoteRef, remoteOid] = fields;
  if (fields.length !== 4 || local === undefined || remoteRef === undefined || remoteOid === undefined) {
    throw fail(GATE_ERROR.unreadableUpdate, { line });
  }
  const fetched = !ABSENT.test(remoteOid) && git(cwd, ["cat-file", "-e", remoteOid]).ok;
  const span = fetched ? [`${remoteOid}..${local}`] : [local, "--not", `--remotes=${remote}`];
  const reverts = ABSENT.test(local)
    ? []
    : git(cwd, ["log", "--no-merges", "--format=%h %s", '--grep=^Revert "', ...span])
        .out.split("\n")
        .filter(Boolean);
  const fastForward = fetched && git(cwd, ["merge-base", "--is-ancestor", remoteOid, local]).ok;
  return { local, remoteRef, remoteOid, fetched, reverts, fastForward };
}

function updateRefusal(update: Update, shared: string, remote: string): readonly string[] {
  const reverts =
    update.reverts.length === 0
      ? []
      : [
          `${PREFIX}this pushes a revert.`,
          ...update.reverts.map((revert) => `  ${revert}`),
          "  drop the commit instead: reset or rebase it out.",
        ];
  if (update.remoteRef !== shared) return reverts;
  if (ABSENT.test(update.local)) return [...reverts, `${PREFIX}this deletes ${shared} on ${remote}.`];
  if (ABSENT.test(update.remoteOid) || update.fastForward) return reverts;
  if (!update.fetched) {
    return [
      ...reverts,
      `${PREFIX}${shared} on ${remote} is at ${update.remoteOid}, which is not in this checkout.`,
      "  fetch before deciding what to do with it.",
    ];
  }
  return [
    ...reverts,
    `${PREFIX}this rewrites ${shared} on ${remote}.`,
    `  its tip ${update.remoteOid} is not in the history being pushed.`,
  ];
}

function refusal(input: GateInput): readonly string[] {
  const pushed = target(input);
  if (pushed === null) return [];
  const remote = pushedRemote(pushed, input.cwd);
  if (remote === null) return [];
  const shared = sharedBranch(remote, input.cwd);
  if (shared === null) return [];
  const lines = input
    .stdin()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => updateRefusal(updateOf(line, remote, input.cwd), shared, remote));
  return lines.length === 0
    ? []
    : [...lines, "  rebase onto it, push a branch, or --no-verify to push anyway."];
}

export const prePushGate: Gate = {
  owner: (input) => {
    const pushed = target(input);
    return pushed === null ? null : remoteSlug(pushed.url);
  },
  refusal,
};
