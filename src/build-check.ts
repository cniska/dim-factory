import type { Evidence, Later, StopOf } from "./order-contract";

export function buildCheckVerdict(
  head: string,
  check: Evidence,
  cleanAfter: boolean,
): Extract<Later, { readonly action: "build_checked" }> | StopOf<"build_refused"> {
  const { command, exitCode } = check;
  if (exitCode !== 0)
    return {
      action: "build_refused",
      code: "check_failed",
      details: { head, command, exitCode },
      evidence: [check],
    };
  if (!cleanAfter)
    return { action: "build_refused", code: "check_rewrote", details: { head, command }, evidence: [check] };
  return { action: "build_checked", details: { head }, evidence: [check] };
}
