import type { Grader } from "../grader-contract";

const RAN = /^Exit code \d+/;

export const noRefusedShell: Grader = {
  name: "no-refused-shell",
  grade({ toolCalls }) {
    const refused = toolCalls.filter(
      (call) => call.name === "Bash" && call.result?.isError === true && !RAN.test(call.result.text),
    );
    return refused.length === 0
      ? { pass: true, reason: "no shell call was refused" }
      : { pass: false, reason: `refused: ${refused.map((call) => String(call.input.command)).join(" | ")}` };
  },
};
