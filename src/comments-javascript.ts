import { type ParserPlugin, parse } from "@babel/parser";
import type { CommentLanguage, CommentSpan } from "./comments-language";

type BabelComment = { type: "CommentLine" | "CommentBlock"; value: string; start: number; end: number };

const READS = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const TYPED_BY_JSDOC = /\.(?:js|mjs|cjs)$/;
const MAY_HOLD_JSX = /\.(?:tsx|jsx|js|mjs|cjs)$/;
const CONTRACT = /^(?:@ts-|eslint-|biome-ignore|prettier-ignore|[#@]__PURE__)/;

function parsed(path: string, text: string, recover: boolean): BabelComment[] | null {
  const language: ParserPlugin[] = /\.(?:ts|mts|cts)$/.test(path)
    ? ["typescript"]
    : path.endsWith(".tsx")
      ? ["typescript", "jsx"]
      : ["jsx"];
  const plugins: ParserPlugin[] = [...language, ["decorators", {}], "decoratorAutoAccessors"];
  try {
    return parse(text, {
      sourceType: "unambiguous",
      plugins,
      errorRecovery: recover,
      allowImportExportEverywhere: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowSuperOutsideMethod: true,
      allowUndeclaredExports: true,
    }).comments as BabelComment[];
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
  reads: (path) => READS.test(path),
  comments: (path, text, { recover }) =>
    parsed(path, text, recover)
      ?.filter((comment) => !isToolContract(comment, path))
      .map(({ start, end }) => ({ start, end })) ?? null,
  extent: jsxExtent,
};
