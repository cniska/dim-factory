import type * as React from "react";
import { cn } from "../../lib/utils";

export function Badge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex h-[16px] w-fit shrink-0 items-center gap-1 rounded-wall border px-1.5 text-[11px] leading-none whitespace-nowrap text-quiet",
        className,
      )}
      {...props}
    />
  );
}
