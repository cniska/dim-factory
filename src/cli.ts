#!/usr/bin/env bun
import { allCommands, COMMAND_NAMES, findCommand } from "./cli-commands";
import { UsageError } from "./cli-contract";
import { listing, writeError, writeResult } from "./cli-output";

const [name, ...args] = process.argv.slice(2);
const command = await findCommand(name);

if (name === undefined) {
  process.exitCode = writeResult("dim", listing(await allCommands()));
} else if (command === undefined) {
  process.exitCode = writeError(
    "dim",
    new UsageError(`${name} is not a dim command; dim with no command lists them`),
    `usage: dim ${COMMAND_NAMES.join("|")}`,
  );
} else {
  try {
    const value = await command.run(args);
    if (!command.raw?.(args)) process.exitCode = writeResult(command.name, value);
  } catch (error) {
    process.exitCode = writeError(command.name, error, command.usage);
  }
}
