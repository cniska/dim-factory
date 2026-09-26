import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@huggingface/transformers";
import {
  BLOB_BYTES,
  EMBED_DIMS,
  type Embedder,
  embedQuestion,
  fromBlob,
  openEmbedder,
  similarity,
  toBlob,
} from "./embed";

function vector(fill: (i: number) => number): Float32Array {
  const v = new Float32Array(EMBED_DIMS);
  for (let i = 0; i < EMBED_DIMS; i++) v[i] = fill(i);
  return v;
}

const norm = (v: Float32Array): number => Math.sqrt(similarity(v, v));

describe("vector storage", () => {
  test("a vector survives the round trip through a blob", () => {
    const original = vector((i) => Math.sin(i) / 2);
    const back = fromBlob(new Uint8Array(toBlob(original)));
    expect([...back]).toEqual([...original]);
  });

  test("a blob is four bytes per dimension", () => {
    expect(toBlob(vector(() => 1)).byteLength).toBe(BLOB_BYTES);
  });

  test("a blob of the wrong length is refused rather than read as a vector", () => {
    expect(() => fromBlob(new Uint8Array(BLOB_BYTES - 4))).toThrow(`this blob is ${BLOB_BYTES - 4}`);
  });

  test("a vector of the wrong width is refused", () => {
    expect(() => toBlob(new Float32Array(128))).toThrow("this one is 128");
  });

  test("a blob read at an unaligned offset is still a vector", () => {
    const padded = new Uint8Array(BLOB_BYTES + 1);
    padded.set(toBlob(vector((i) => i / EMBED_DIMS)), 1);
    const back = fromBlob(padded.subarray(1));
    expect(back[7]).toBeCloseTo(7 / EMBED_DIMS, 6);
  });
});

describe("similarity", () => {
  test("a unit vector against itself is one", () => {
    const unit = vector((i) => (i === 0 ? 1 : 0));
    expect(similarity(unit, unit)).toBeCloseTo(1, 6);
  });

  test("orthogonal unit vectors score zero", () => {
    const a = vector((i) => (i === 0 ? 1 : 0));
    const b = vector((i) => (i === 1 ? 1 : 0));
    expect(similarity(a, b)).toBeCloseTo(0, 6);
  });

  test("opposed unit vectors score minus one", () => {
    const a = vector((i) => (i === 0 ? 1 : 0));
    const b = vector((i) => (i === 0 ? -1 : 0));
    expect(similarity(a, b)).toBeCloseTo(-1, 6);
  });
});

describe("reading a question", () => {
  test("a model that fails mid-inference comes back as unavailable, not as a throw", async () => {
    const breaks: Embedder = async () => {
      throw new Error("onnxruntime session ran out of memory");
    };
    const question = await embedQuestion("what broke the worktree", process.env, async () => breaks);
    expect(question).toEqual({ unavailable: "onnxruntime session ran out of memory" });
  });

  test("a model that returns nothing comes back as unavailable", async () => {
    const empty: Embedder = async () => [];
    const question = await embedQuestion("what broke the worktree", process.env, async () => empty);
    expect(question).toHaveProperty("unavailable");
  });
});

describe("the no-network invariant", () => {
  test("a cache miss fails rather than reaching the hub", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dim-embed-"));
    const reached: string[] = [];
    const real = env.fetch;
    env.fetch = async (input: string | URL) => {
      reached.push(String(input));
      throw new Error("the test refuses the network");
    };
    let code: unknown;
    try {
      await openEmbedder({ DIM_HOME: dir });
    } catch (error) {
      code = (error as { code?: unknown }).code;
    } finally {
      env.fetch = real;
      rmSync(dir, { recursive: true, force: true });
    }
    expect(reached).toEqual([]);
    expect(code).toBe("EMBEDDER_UNAVAILABLE");
  }, 120_000);
});

describe("the local model", () => {
  test("returns unit vectors, which is what makes similarity a cosine", async () => {
    const embed = await openEmbedder();
    const [one, two] = await embed(["the worktree convention has one definition", "a parser bug"]);
    expect(one).toBeDefined();
    expect(two).toBeDefined();
    expect((one as Float32Array).length).toBe(EMBED_DIMS);
    expect(norm(one as Float32Array)).toBeCloseTo(1, 4);
    expect(norm(two as Float32Array)).toBeCloseTo(1, 4);
  }, 120_000);

  test("ranks a paraphrase above an unrelated sentence, sharing no words with either", async () => {
    const embed = await openEmbedder();
    const [question, paraphrase, unrelated] = await embed([
      "how do I undo what an agent wrote without touching my repository",
      "reverting changes a coding assistant made, leaving the checkout alone",
      "input, cache and output tokens per tool and model",
    ]);
    const near = similarity(question as Float32Array, paraphrase as Float32Array);
    const far = similarity(question as Float32Array, unrelated as Float32Array);
    expect(near).toBeGreaterThan(far);
  }, 120_000);

  test("embeds nothing when given nothing", async () => {
    const embed = await openEmbedder();
    expect(await embed([])).toEqual([]);
  }, 120_000);
});
