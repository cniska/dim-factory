import type * as React from "react";
import { cn } from "../../lib/utils";

export function Badge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex min-h-[16px] w-fit shrink-0 items-center gap-[var(--space-xs)] rounded-wall border px-[var(--space-sm)] py-[var(--space-xs)] text-[11px] leading-none whitespace-nowrap text-quiet",
        className,
      )}
      {...props}
    />
  );
}
