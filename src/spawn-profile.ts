import { existsSync } from "node:fs";
import { join } from "node:path";
import { CAPABILITIES, type Capability, isCapability } from "./capabilities";
import { duplicateKeys, parseJsonc } from "./jsonc";
import { readJsoncText } from "./jsonc-file";
import { dataDir, type Env } from "./paths";

/** Every granted value is joined into one argument, deduplicated in the order capabilities were requested. */
export type Slot = { join: string };

export type SpawnProfile = {
  argv: string[];
  slots: Record<string, Slot>;
  grants: Partial<Record<Capability, Partial<Record<string, string[]>>>>;
};

/** `path` is the spawn profile, and is unset where the capability rather than the file is wrong. */
export class SpawnProfileError extends Error {
  constructor(
    readonly kind: "no-profile" | "malformed" | "ungranted",
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "SpawnProfileError";
  }
}

/**
 * One file per machine, beside the database rather than in any checkout, same as
 * `routing.json`: which harness is driving the floor is a property of the machine,
 * not of the repo being worked on.
 */
export function spawnProfilePath(env: Env = process.env): string {
  return join(dataDir(env), "spawn.json");
}

const TEMPLATE =
  '{ "argv": ["<harness>", "{brief}", "--model", "{model}", "--tools", "{tools}"], ' +
  '"slots": { "tools": { "join": "," } }, ' +
  '"grants": { "read-files": { "tools": ["Read"] } } }';

export function readSpawnProfile(env: Env = process.env): SpawnProfile {
  const path = spawnProfilePath(env);
  if (!existsSync(path)) {
    throw new SpawnProfileError(
      "no-profile",
      `${path}: no spawn profile, so no station can be started; write ${TEMPLATE}`,
      path,
    );
  }
  const text = readJsoncText(path);
  const repeated = duplicateKeys(text, { deep: true });
  if (repeated.length > 0) {
    throw new SpawnProfileError(
      "malformed",
      `${path}: names ${repeated.join(", ")} twice, so one value silently replaced another`,
      path,
    );
  }
  const raw = parseJsonc<unknown>(text, path);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SpawnProfileError(
      "malformed",
      `${path}: the spawn profile is not an object of ${TEMPLATE}`,
      path,
    );
  }
  const { argv, slots, grants } = raw as Record<string, unknown>;
  if (!Array.isArray(argv) || argv.some((token) => typeof token !== "string")) {
    throw new SpawnProfileError("malformed", `${path}: argv is not an array of strings`, path);
  }
  if (slots === null || typeof slots !== "object" || Array.isArray(slots)) {
    throw new SpawnProfileError(
      "malformed",
      `${path}: slots is not an object of { "join": "<separator>" }`,
      path,
    );
  }
  const parsedSlots: Record<string, Slot> = {};
  for (const [name, value] of Object.entries(slots as Record<string, unknown>)) {
    if (
      value === null ||
      typeof value !== "object" ||
      typeof (value as Record<string, unknown>).join !== "string"
    ) {
      throw new SpawnProfileError(
        "malformed",
        `${path}: slot ${name} is not { "join": "<separator>" }`,
        path,
      );
    }
    if (!argv.includes(`{${name}}`)) {
      throw new SpawnProfileError(
        "malformed",
        `${path}: slot ${name} has no {${name}} placeholder in argv`,
        path,
      );
    }
    parsedSlots[name] = { join: (value as { join: string }).join };
  }
  if (grants === null || typeof grants !== "object" || Array.isArray(grants)) {
    throw new SpawnProfileError(
      "malformed",
      `${path}: grants is not an object of capability to slot values`,
      path,
    );
  }
  const parsedGrants: SpawnProfile["grants"] = {};
  for (const [capability, bySlot] of Object.entries(grants as Record<string, unknown>)) {
    if (!isCapability(capability)) {
      throw new SpawnProfileError(
        "malformed",
        `${path}: grants names ${capability}, which is no capability; the capabilities are ${CAPABILITIES.join(", ")}`,
        path,
      );
    }
    if (bySlot === null || typeof bySlot !== "object" || Array.isArray(bySlot)) {
      throw new SpawnProfileError(
        "malformed",
        `${path}: ${capability} grants is not an object of slot to values`,
        path,
      );
    }
    const parsedBySlot: Record<string, string[]> = {};
    for (const [slotName, values] of Object.entries(bySlot as Record<string, unknown>)) {
      if (!(slotName in parsedSlots)) {
        throw new SpawnProfileError(
          "malformed",
          `${path}: ${capability} grants into ${slotName}, which slots does not define`,
          path,
        );
      }
      if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) {
        throw new SpawnProfileError(
          "malformed",
          `${path}: ${capability}.${slotName} is not an array of strings`,
          path,
        );
      }
      parsedBySlot[slotName] = values as string[];
    }
    parsedGrants[capability] = parsedBySlot;
  }
  for (const token of argv) {
    const match = /^\{(.+)\}$/.exec(token);
    if (match && match[1] !== "model" && match[1] !== "brief" && !((match[1] as string) in parsedSlots)) {
      throw new SpawnProfileError(
        "malformed",
        `${path}: argv names the placeholder ${token}, which is neither {model}, {brief}, nor a declared slot`,
        path,
      );
    }
  }
  return { argv, slots: parsedSlots, grants: parsedGrants };
}

/**
 * Pure: no process, no environment, no database, which is what lets every case
 * here be tested without a harness installed. A capability the profile says
 * nothing about is refused rather than silently dropped, because a station
 * quietly started without a write it needed is a round that cannot raise anything.
 */
export function spawnArgv(
  profile: SpawnProfile,
  options: { model: string; brief: string; capabilities: Capability[] },
): string[] {
  const bySlot: Record<string, string[]> = {};
  for (const name of Object.keys(profile.slots)) bySlot[name] = [];
  for (const capability of options.capabilities) {
    const grant = profile.grants[capability];
    if (!grant) {
      throw new SpawnProfileError(
        "ungranted",
        `${capability}: the spawn profile grants nothing for this capability`,
      );
    }
    for (const [slotName, values] of Object.entries(grant)) {
      bySlot[slotName] ??= [];
      const collected = bySlot[slotName] as string[];
      for (const value of values ?? []) {
        if (!collected.includes(value)) collected.push(value);
      }
    }
  }
  return profile.argv.map((token) => {
    if (token === "{model}") return options.model;
    if (token === "{brief}") return options.brief;
    const match = /^\{(.+)\}$/.exec(token);
    const slot = match && profile.slots[match[1] as string];
    if (match && slot) return (bySlot[match[1] as string] ?? []).join(slot.join);
    return token;
  });
}
