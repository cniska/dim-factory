import { existsSync, readFileSync } from "node:fs";
import {
  applyEdits,
  type FormattingOptions,
  findNodeAtLocation,
  type JSONPath,
  modify,
  type Node,
  type ParseError,
  parse,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";

/** `kind` rather than a message, so a caller can tell a malformed file from a surprising shape. */
export class JsoncError extends Error {
  constructor(
    readonly kind: "parse" | "not-an-array" | "not-an-object",
    readonly where: string,
    message: string,
  ) {
    super(message);
    this.name = "JsoncError";
  }
}

export function parseJsonc<T>(text: string, where: string): T {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as T;
  if (errors.length > 0) {
    const first = errors[0] as ParseError;
    throw new JsoncError(
      "parse",
      where,
      `${where}: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }
  return value;
}

/** Null where the file is absent. */
export function readJsonc<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return parseJsonc<T>(readFileSync(path, "utf8"), path);
}

/** The file's own indent, so what is inserted lines up with what is already there. */
function indentOf(text: string): FormattingOptions {
  const indent = text.match(/^[ \t]+(?=\S)/m)?.[0];
  if (indent === undefined) return { tabSize: 2, insertSpaces: true };
  return indent.startsWith("\t")
    ? { tabSize: 1, insertSpaces: false }
    : { tabSize: indent.length, insertSpaces: true };
}

/**
 * Every node `modify` would write through has to be the shape the write assumes,
 * checked here so a surprising config raises a `JsoncError` a caller can branch
 * on rather than the library's own message.
 */
function refuseWrongShape(root: Node, path: JSONPath): void {
  for (let depth = 0; depth < path.length; depth++) {
    const parent = findNodeAtLocation(root, path.slice(0, depth));
    if (!parent) return; // absent, so the write creates it
    if (parent.type !== "object") {
      throw new JsoncError("not-an-object", at(path, depth), `${at(path, depth)} holds a ${parent.type}`);
    }
  }
  const target = findNodeAtLocation(root, path);
  if (target && target.type !== "array") {
    const where = at(path, path.length);
    throw new JsoncError("not-an-array", where, `${where} holds a ${target.type}`);
  }
}

function at(path: JSONPath, depth: number): string {
  return path.slice(0, depth).join(".") || "the document root";
}

/**
 * Append to the array at `path`, creating it and its parents where absent, and
 * rewriting only the bytes around the insertion: a comment, a key order or an
 * indent the file already carries survives, which round-tripping through
 * `JSON.stringify` discards.
 */
export function appendToJsoncArray(text: string, path: JSONPath, value: unknown): string {
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (root) refuseWrongShape(root, path);
  const target = root && findNodeAtLocation(root, path);
  const formattingOptions = indentOf(text);
  const edits = target
    ? modify(text, [...path, -1], value, { formattingOptions, isArrayInsertion: true })
    : modify(text, path, [value], { formattingOptions });
  const edited = applyEdits(text, edits);
  const wantsFinalNewline = text === "" || text.endsWith("\n");
  return wantsFinalNewline && !edited.endsWith("\n") ? `${edited}\n` : edited;
}
