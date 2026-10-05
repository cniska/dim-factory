import { type ParserPlugin, parse } from "@babel/parser";

function pluginsFor(path: string): ParserPlugin[] {
  const language: ParserPlugin[] = /\.(?:ts|mts|cts)$/.test(path)
    ? ["typescript"]
    : path.endsWith(".tsx")
      ? ["typescript", "jsx"]
      : ["jsx"];
  return [...language, ["decorators", {}], "decoratorAutoAccessors"];
}

export function parseJavaScript(path: string, text: string, recover: boolean) {
  return parse(text, {
    sourceType: "unambiguous",
    plugins: pluginsFor(path),
    errorRecovery: recover,
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
  });
}
