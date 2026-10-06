import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundleGates, GATE_BUNDLES_DIR } from "./gate-bundles";

mkdirSync(GATE_BUNDLES_DIR, { recursive: true });
for (const [file, text] of Object.entries(await bundleGates()))
  writeFileSync(join(GATE_BUNDLES_DIR, file), text);
