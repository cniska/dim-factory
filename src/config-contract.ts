import { z } from "zod";

export type Layer = "user" | "project";

export const SHIP_WAYS = ["default-branch"] as const;

const taskName = z.string().regex(/^[A-Za-z0-9][\w:.-]*$/, "takes the name of a task the project declares");

const modelName = z.string().trim().min(1);

export const Tasks = z.strictObject({ check: taskName.optional(), format: taskName.optional() });

export const Models = z.strictObject({
  default: modelName.optional(),
  planner: modelName.optional(),
  builder: modelName.optional(),
  reviewer: modelName.optional(),
});
export type Models = z.infer<typeof Models>;

export type Config = {
  readonly ship?: (typeof SHIP_WAYS)[number];
  readonly tasks?: z.infer<typeof Tasks>;
};

export type UserConfig = Config & { readonly models?: Models };

export const TASK_DEFAULTS = { check: "check", format: "format" } as const;

export type TaskSetting = keyof typeof TASK_DEFAULTS;

export function taskOf(config: Config, setting: TaskSetting): string {
  return config.tasks?.[setting] ?? TASK_DEFAULTS[setting];
}

type SettingKey = { readonly layers: readonly Layer[]; readonly schema: z.ZodType };

export const SETTING_KEYS: Readonly<Record<string, SettingKey>> = {
  ship: { layers: ["user", "project"], schema: z.enum(SHIP_WAYS) },
  "tasks.check": { layers: ["project"], schema: taskName },
  "tasks.format": { layers: ["project"], schema: taskName },
  ...Object.fromEntries(
    Object.keys(Models.shape).map((role) => [`models.${role}`, { layers: ["user"], schema: modelName }]),
  ),
};

export const LAYER_SECTIONS: Readonly<Record<Layer, readonly string[]>> = {
  user: ["ship", "models"],
  project: ["ship", "tasks", "gates"],
};

export function isSettingKey(key: string): boolean {
  return Object.hasOwn(SETTING_KEYS, key);
}
