import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { machineRoot } from "./machine-dirs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a new machine removes the directories of runs whose process is gone, and keeps live ones", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dim-machine-dirs-test-"));
  roots.push(tmp);
  const ended = Bun.spawnSync(["true"]).pid;
  const abandoned = join(tmp, `dim-acceptance-${ended}-abcdef`);
  const live = join(tmp, `dim-acceptance-${process.pid}-ghijkl`);
  const unrelated = join(tmp, "dim-check-mnopqr");
  for (const dir of [abandoned, live, unrelated]) mkdirSync(dir);

  const root = machineRoot(tmp);

  expect(existsSync(abandoned)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(existsSync(unrelated)).toBe(true);
  expect(basename(root)).toStartWith(`dim-acceptance-${process.pid}-`);
});
