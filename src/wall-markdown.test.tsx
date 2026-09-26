import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WallMarkdown } from "./wall-markdown";

test("artifact Markdown renders a table with a scrollable container", () => {
  const html = renderToStaticMarkup(
    <WallMarkdown>{"| Dimension | Status |\n| --- | --- |\n| Tests | **clean** |"}</WallMarkdown>,
  );

  expect(html).toContain('<div class="wall-table-scroll"><table>');
  expect(html).toContain("<thead><tr><th>Dimension</th><th>Status</th></tr></thead>");
  expect(html).toContain("<tbody><tr><td>Tests</td><td><strong>clean</strong></td></tr></tbody>");
});

test("fenced callgraphs keep their indentation and line breaks", () => {
  const html = renderToStaticMarkup(
    <WallMarkdown>{"```text\nroot\n  child\n    leaf\n| code | not a table |\n```"}</WallMarkdown>,
  );

  expect(html).toContain("<pre><code");
  expect(html).toContain("root\n  child\n    leaf\n| code | not a table |");
  expect(html).not.toContain("<table>");
});
