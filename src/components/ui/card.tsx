import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils";

const card = cva("relative flex min-w-0 flex-col overflow-hidden rounded-wall border p-[var(--space-md)]", {
  variants: {
    // The only card that looks different is one that stopped, so a column reads as moving
    // or not before any of its text resolves.
    stopped: {
      true: "border-alert-border bg-card-stopped",
      false: "bg-card",
    },
  },
  defaultVariants: { stopped: false },
});

export type CardVariants = VariantProps<typeof card>;

export function Card({ className, stopped, ...props }: React.ComponentProps<"article"> & CardVariants) {
  return <article className={cn(card({ stopped }), className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-center", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex min-w-0 flex-col", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-center", className)} {...props} />;
}
