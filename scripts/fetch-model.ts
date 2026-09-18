#!/usr/bin/env bun
import { downloadEmbedder, EMBED_MODEL, modelCacheDir } from "../src/embed";

// The suite loads the model through `openEmbedder`, which refuses the network, and
// `dim embed` needs a database CI has none of. So a cold cache is filled from here.
await downloadEmbedder();
console.log(`${EMBED_MODEL} is in ${modelCacheDir()}`);
