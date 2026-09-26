import { type Command, UsageError } from "./cli-contract";
import { parseHarness } from "./harness-name";
import { routeReport } from "./worker-routing";

export const routeCommand: Command = {
  name: "route",
  usage: "usage: dim route <harness> [<role>]",
  summary: "print the capability tier a factory role runs at and what this harness's map calls it",
  run: (args) =>
    routeReport(
      parseHarness(args[0], (message) => new UsageError(message)),
      args[1],
    ),
};
