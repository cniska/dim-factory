import type { Grader } from "../grader-contract";

export const noRefusedShell: Grader = {
  name: "no-refused-shell",
  grade({ toolCalls }) {
    const refused = toolCalls.filter((call) => call.name === "Bash" && call.denied !== null);
    return refused.length === 0
      ? { pass: true, reason: "no shell call was refused" }
      : {
          pass: false,
          reason: `refused: ${refused.map((call) => `${String(call.input.command)} (${call.denied})`).join(" | ")}`,
        };
  },
};
