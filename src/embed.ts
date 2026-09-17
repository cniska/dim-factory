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
    super(`the embedding model would not load: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** Unit vectors, one per text, in the order the texts were given. */
export type Embedder = (texts: string[]) => Promise<Float32Array[]>;

/** Beside the database, so reinstalling dependencies does not throw away the download. */
export function modelCacheDir(e: Env = process.env): string {
  return join(dataDir(e), "models");
}

export async function openEmbedder(e: Env = process.env): Promise<Embedder> {
  env.cacheDir = modelCacheDir(e);
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
      // Mean pooling and L2 normalization are how all-MiniLM-L6-v2 was trained
      // to be read; normalizing here is also what makes `similarity` a cosine.
      const out = await extract(batch, { pooling: "mean", normalize: true });
      const flat = out.data as Float32Array;
      for (let i = 0; i < batch.length; i++) {
        vectors.push(flat.slice(i * EMBED_DIMS, (i + 1) * EMBED_DIMS));
      }
    }
    return vectors;
  };
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
  // Copied: SQLite hands back a view at an offset with no four-byte alignment,
  // and a Float32Array over an unaligned offset throws.
  return new Float32Array(blob.slice().buffer);
}

/**
 * A question resolved into something a query can rank with, or the reason it
 * could not be. Carried as a value rather than thrown, because a retrieval path
 * that can break is a path nobody relies on: the caller degrades to keywords.
 */
export type Question = { vector: Float32Array } | { unavailable: string };

export async function embedQuestion(text: string, e: Env = process.env): Promise<Question> {
  let embed: Embedder;
  try {
    embed = await openEmbedder(e);
  } catch (error) {
    if (error instanceof EmbedderUnavailableError) return { unavailable: error.message };
    throw error;
  }
  const [vector] = await embed([text]);
  if (!vector) return { unavailable: "the model returned no vector for the question" };
  return { vector };
}

/** Both sides are unit vectors, so their dot product is the cosine between them. */
export function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < EMBED_DIMS; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}
