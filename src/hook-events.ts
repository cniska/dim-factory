export const HOOK_EVENTS = { SessionStart: "session_start", SessionEnd: "session_end" } as const;

export type HookEvent = (typeof HOOK_EVENTS)[keyof typeof HOOK_EVENTS];

const BY_HOOK_NAME: ReadonlyMap<string, HookEvent> = new Map(Object.entries(HOOK_EVENTS));

export function hookEventOf(name: string | undefined): HookEvent | undefined {
  return name === undefined ? undefined : BY_HOOK_NAME.get(name);
}
