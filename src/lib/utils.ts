import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// twMerge rather than a join, so a caller's `p-2` replaces a base `p-4` instead of
// landing beside it and losing to whichever the stylesheet happens to order last.
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
