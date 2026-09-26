import { join } from "node:path";
import { env, pipeline } from "@huggingface/transformers";
import { dataDir, type Env } from "./paths";

export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBED_DIMS = 384;
export const BLOB_BYTES = EMBED_DIMS * 4;

const BATCH = 32;

export class EmbedderUnavailableError extends Error {
  readonly code = "EMBEDDER_UNAVAILABLE";
  constructor(cause: unknown) {
    super(
      `the embedding model would not load, and \`dim embed\` is what fetches it: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

export type Embedder = (texts: string[]) => Promise<Float32Array[]>;

export function modelCacheDir(e: Env = process.env): string {
  return join(dataDir(e), "models");
}

async function load(e: Env, allowRemoteModels: boolean): Promise<Embedder> {
  env.cacheDir = modelCacheDir(e);
  env.allowRemoteModels = allowRemoteModels;
  let extract: Awaited<ReturnType<typeof pipeline<"feature-extraction">>>;
  try {
    extract = await pipeline("feature-extraction", EMBED_MODEL);
  } catch (error) {
    throw new EmbedderUnavailableError(error);
  }

  return async (texts) => {
    const vectors: Float32Array[] = [];
    for (let at = 0; at < texts.length; at += BATCH) {
      const batch = texts.slice(at, at + BATCH);
      const out = await extract(batch, { pooling: "mean", normalize: true });
      const flat = out.data as Float32Array;
      for (let i = 0; i < batch.length; i++) {
        vectors.push(flat.slice(i * EMBED_DIMS, (i + 1) * EMBED_DIMS));
      }
    }
    return vectors;
  };
}

export function openEmbedder(e: Env = process.env): Promise<Embedder> {
  return load(e, false);
}

export function downloadEmbedder(e: Env = process.env): Promise<Embedder> {
  return load(e, true);
}

export function toBlob(vector: Float32Array): Uint8Array {
  if (vector.length !== EMBED_DIMS) {
    throw new Error(`a vector is ${EMBED_DIMS} floats, this one is ${vector.length}`);
  }
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  if (blob.byteLength !== BLOB_BYTES) {
    throw new Error(`a vector is ${BLOB_BYTES} bytes, this blob is ${blob.byteLength}`);
  }
  return new Float32Array(blob.slice().buffer);
}

export type Question = { vector: Float32Array } | { unavailable: string };

export async function embedQuestion(
  text: string,
  e: Env = process.env,
  open: (e: Env) => Promise<Embedder> = openEmbedder,
): Promise<Question> {
  try {
    const embed = await open(e);
    const [vector] = await embed([text]);
    if (!vector) return { unavailable: "the model returned no vector for the question" };
    return { vector };
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

export function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < EMBED_DIMS; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}
