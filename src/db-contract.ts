import { refuser } from "./coded-error";

export const refuseRecord = refuser<{
  readonly record_version: { readonly found: number; readonly expected: number };
  readonly no_database: { readonly path: string };
  readonly lock_held: { readonly path: string; readonly pid: number };
}>({
  record_version: {
    message: ({ found, expected }) =>
      `the record is schema version ${found} and this dim reads version ${expected}; run \`dim rebuild\``,
    resolve: () => "dim rebuild",
  },
  no_database: {
    message: ({ path }) => `no database at ${path}; run \`dim sync\` first`,
    resolve: () => "dim sync",
  },
  lock_held: {
    message: ({ path, pid }) => `another dim run holds ${path} (pid ${pid}); run this again once it ends`,
    resolve: ({ pid }) => `run this again once process ${pid} has ended`,
  },
});
