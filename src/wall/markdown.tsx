import { Children, isValidElement, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

function MarkdownLink({ children }: { children?: ReactNode }) {
  const parts = Children.toArray(children);
  const first = parts[0];

  if (parts.length === 1 && isValidElement(first) && first.type === "code") return first;
  return <code>{children}</code>;
}

function MarkdownImage({ alt }: { alt?: string }) {
  return <>{alt}</>;
}

function MarkdownTable({ children }: { children?: ReactNode }) {
  return (
    <div className="wall-table-scroll">
      <table>{children}</table>
    </div>
  );
}

export function WallMarkdown({ children }: { children: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{ a: MarkdownLink, img: MarkdownImage, table: MarkdownTable }}
    >
      {children}
    </Markdown>
  );
}
