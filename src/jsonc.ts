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
import { ConfigError } from "./config-error";

export function parseJsonc<T>(text: string, file: string): T {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true }) as T;
  if (errors.length > 0) {
    const first = errors[0] as ParseError;
    throw new ConfigError(
      "parse",
      file,
      `${file}: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }
  return value;
}

/**
 * `parse` keeps the last of a repeated key and reports no error, so a file a
 * person edits by hand needs the tree to see that one value was overwritten by
 * another. Top-level keys only by default, which is the depth a flat map like
 * `routing.json` collides at; `deep` walks every nested object, for a config
 * whose keys can collide more than one level down.
 */
export function duplicateKeys(text: string, options: { deep?: boolean } = {}): string[] {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const found: string[] = [];
  function walk(node: Node | undefined, path: string[]): void {
    if (node?.type !== "object") return;
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== "string") continue;
      if (seen.has(key)) found.push([...path, key].join("."));
      seen.add(key);
      if (options.deep) walk(property.children?.[1], [...path, key]);
    }
  }
  walk(root, []);
  return found;
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
 * checked here so a surprising config raises a `ConfigError` a caller can branch
 * on rather than the library's own message.
 */
function refuseWrongShape(root: Node, path: JSONPath, file: string): void {
  for (let depth = 0; depth < path.length; depth++) {
    const parent = findNodeAtLocation(root, path.slice(0, depth));
    if (!parent) return; // absent, so the write creates it
    if (parent.type !== "object") {
      const label = pathLabel(path, depth);
      throw new ConfigError("not-an-object", file, `${label} holds a ${parent.type}`, label);
    }
  }
  const target = findNodeAtLocation(root, path);
  if (target && target.type !== "array") {
    const label = pathLabel(path, path.length);
    throw new ConfigError("not-an-array", file, `${label} holds a ${target.type}`, label);
  }
}

function pathLabel(path: JSONPath, depth: number): string {
  return path.slice(0, depth).join(".") || "the document root";
}

/**
 * Replace the value at `path`, which has to be there already. Absent is a refusal
 * rather than a write, because every caller replacing something is correcting an
 * entry it located, and creating one instead leaves the entry it meant to correct.
 */
export function setJsoncValue(text: string, path: JSONPath, value: unknown, file: string): string {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const label = path.join(".");
  if (!root || !findNodeAtLocation(root, path)) {
    throw new ConfigError("absent", file, `${file}: ${label} is not there to replace`, label);
  }
  return applyEdits(text, modify(text, path, value, { formattingOptions: indentOf(text) }));
}

/**
 * Append to the array at `path`, creating it and its parents where absent. A
 * comment, a sibling key and the file's own indent survive, which round-tripping
 * through `JSON.stringify` discards; the array written into is reformatted,
 * because `modify` re-lays-out the lines its insertion touches.
 */
export function appendToJsoncArray(text: string, path: JSONPath, value: unknown, file: string): string {
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (root) refuseWrongShape(root, path, file);
  const target = root && findNodeAtLocation(root, path);
  const formattingOptions = indentOf(text);
  const edits = target
    ? modify(text, [...path, -1], value, { formattingOptions, isArrayInsertion: true })
    : modify(text, path, [value], { formattingOptions });
  const edited = applyEdits(text, edits);
  const wantsFinalNewline = text === "" || text.endsWith("\n");
  return wantsFinalNewline && !edited.endsWith("\n") ? `${edited}\n` : edited;
}
