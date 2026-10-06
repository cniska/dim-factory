import { join, resolve } from "node:path";
import { invariant } from "./assert";

const SRC = resolve(import.meta.dir);

export const GATE_BUNDLES_DIR = resolve(import.meta.dir, "..", "gates", "no-comments");

export const GATE_BUNDLES = [
  { entry: "no-comments-scan-main.ts", file: "scan.cjs", version: 1 },
  { entry: "no-comments-javascript.ts", file: "javascript.cjs", version: 1 },
] as const;

export async function bundleGates(): Promise<Record<string, string>> {
  const built: Record<string, string> = {};
  for (const { entry, file, version } of GATE_BUNDLES) {
    const output = await Bun.build({
      entrypoints: [join(SRC, entry)],
      target: "node",
      format: "cjs",
      minify: true,
      banner: `// dim-gate:${version}`,
    });
    invariant(output.success, `bundling ${entry} succeeds: ${output.logs.join("\n")}`);
    const [artifact] = output.outputs;
    invariant(artifact !== undefined, `bundling ${entry} writes one file`);
    built[file] = await artifact.text();
  }
  return built;
}
