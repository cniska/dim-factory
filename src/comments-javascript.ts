import type { CommentLanguage, CommentSpan } from "./comments-language";
import { parseJavaScript } from "./javascript-parse";

type BabelComment = { type: "CommentLine" | "CommentBlock"; value: string; start: number; end: number };

const READS = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TYPED_BY_JSDOC = /\.(?:js|mjs|cjs)$/;
const MAY_HOLD_JSX = /\.(?:tsx|jsx|js|mjs|cjs)$/;
const CONTRACT = /^(?:@ts-|eslint-|biome-ignore|prettier-ignore|[#@]__PURE__)/;

function parsed(path: string, text: string, recover: boolean): BabelComment[] | null {
  try {
    const { comments } = parseJavaScript(path, text, recover);
    return (comments ?? []).flatMap(({ type, value, start, end }): BabelComment[] =>
      start == null || end == null ? [] : [{ type, value, start, end }],
    );
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isToolContract(comment: BabelComment, path: string): boolean {
  if (comment.type === "CommentLine" && /^\/\s*<reference\b/.test(comment.value)) return true;
  if (comment.type === "CommentBlock" && comment.value.startsWith("!")) return true;
  const body = comment.value.replace(/^[\s*]*/, "");
  if (CONTRACT.test(body)) return true;
  if (!TYPED_BY_JSDOC.test(path) || comment.type !== "CommentBlock" || !comment.value.startsWith("*")) {
    return false;
  }
  if (/^@(?:type|typedef)\b/.test(body)) return true;
  const lines = comment.value
    .split("\n")
    .map((line) => line.replace(/^[\s*]*/, "").trim())
    .filter((line) => line !== "");
  return lines.length > 0 && lines.every((line) => /^@param\b/.test(line));
}

function jsxExtent(path: string, text: string, comment: CommentSpan): CommentSpan {
  if (!MAY_HOLD_JSX.test(path)) return comment;
  const before = /\{\s*$/.exec(text.slice(0, comment.start));
  const after = /^\s*\}/.exec(text.slice(comment.end));
  if (!before || !after) return comment;
  return { start: comment.start - before[0].length, end: comment.end + after[0].length };
}

export const javascriptComments: CommentLanguage = {
  name: "javascript",
  reads: (path) => READS.test(path),
  comments: (path, text, { recover }) =>
    parsed(path, text, recover)
      ?.filter((comment) => !isToolContract(comment, path))
      .map(({ start, end }) => ({ start, end })) ?? null,
  extent: jsxExtent,
};
