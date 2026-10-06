import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { invariant } from "./assert";
import { scan, verdict } from "./no-comments-scan";

const script = process.argv[1];
invariant(script !== undefined, "node names the script it runs");
const { lines, failed } = verdict(scan(process.cwd(), dirname(realpathSync(script))));
for (const line of lines) process.stderr.write(`${line}\n`);
process.exitCode = failed ? 1 : 0;
