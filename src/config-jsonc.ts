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
import type { z } from "zod";
import { invalidConfig, refuseConfig } from "./config-error";

export function parseJsonc<S extends z.ZodType>(text: string, file: string, schema: S): z.infer<S> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  const [first] = errors;
  if (first) {
    throw refuseConfig("config_unparsed", {
      path: file,
      detail: `${printParseErrorCode(first.error)} at offset ${first.offset}`,
    });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidConfig(file, parsed.error);
  return parsed.data;
}

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

function indentOf(text: string): FormattingOptions {
  const indent = text.match(/^[ \t]+(?=\S)/m)?.[0];
  if (indent === undefined) return { tabSize: 2, insertSpaces: true };
  return indent.startsWith("\t")
    ? { tabSize: 1, insertSpaces: false }
    : { tabSize: indent.length, insertSpaces: true };
}

function refuseWrongShape(root: Node, path: JSONPath, file: string): void {
  for (let depth = 0; depth < path.length; depth++) {
    const parent = findNodeAtLocation(root, path.slice(0, depth));
    if (!parent) return;
    if (parent.type !== "object") {
      const label = pathLabel(path, depth);
      throw refuseConfig("config_not_an_object", { path: file, at: label, holds: parent.type });
    }
  }
  const target = findNodeAtLocation(root, path);
  if (target && target.type !== "array") {
    const label = pathLabel(path, path.length);
    throw refuseConfig("config_not_an_array", { path: file, at: label, holds: target.type });
  }
}

function pathLabel(path: JSONPath, depth: number): string {
  return path.slice(0, depth).join(".") || "the document root";
}

export function setJsoncValue(text: string, path: JSONPath, value: unknown, file: string): string {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const label = path.join(".");
  if (!root || !findNodeAtLocation(root, path)) {
    throw refuseConfig("config_absent", { path: file, at: label });
  }
  return applyEdits(text, modify(text, path, value, { formattingOptions: indentOf(text) }));
}

export function removeJsoncValue(text: string, path: JSONPath, file: string): string {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const node = root && findNodeAtLocation(root, path);
  if (!node) throw refuseConfig("config_absent", { path: file, at: path.join(".") });
  const target = node.parent?.type === "property" ? node.parent : node;
  const siblings = target.parent?.children ?? [];
  const at = siblings.indexOf(target);
  const next = siblings[at + 1];
  const previous = siblings[at - 1];
  const end = target.offset + target.length;
  if (next) return text.slice(0, target.offset) + text.slice(next.offset);
  if (previous) return text.slice(0, previous.offset + previous.length) + text.slice(end);
  return text.slice(0, target.offset) + text.slice(end);
}

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
