#!/usr/bin/env bun
import { downloadEmbedder, EMBED_MODEL, modelCacheDir } from "../src/search-embed";

await downloadEmbedder();
console.log(`${EMBED_MODEL} is in ${modelCacheDir()}`);
