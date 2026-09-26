#!/usr/bin/env bun
import { downloadEmbedder, EMBED_MODEL, modelCacheDir } from "../src/embed";

await downloadEmbedder();
console.log(`${EMBED_MODEL} is in ${modelCacheDir()}`);
