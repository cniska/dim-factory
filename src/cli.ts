#!/usr/bin/env bun
import { UsageError } from "./command";
import { listing, writeError, writeResult } from "./command-output";
import { COMMANDS, findCommand } from "./commands";

const [name, ...args] = process.argv.slice(2);
const command = findCommand(name);

if (name === undefined) {
  process.exitCode = writeResult("dim", listing(COMMANDS));
} else if (command === undefined) {
  process.exitCode = writeError(
    "dim",
    new UsageError(`${name} is not a dim command; dim with no command lists them`),
  );
} else {
  try {
    const value = await command.run(args);
    if (!command.raw?.(args)) process.exitCode = writeResult(command.name, value);
  } catch (error) {
    process.exitCode = writeError(command.name, error, command.usage);
  }
}
