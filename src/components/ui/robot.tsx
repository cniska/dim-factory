import { Bot } from "lucide-react";
import { cn } from "../../lib/utils";

/** Which agent holds a card is read from the name beside this; the mark only says an agent. */
export function Robot({ label, className }: { label: string; className?: string }) {
  return (
    <Bot role="img" aria-label={label} size={14} strokeWidth={2} className={cn("shrink-0", className)} />
  );
}
