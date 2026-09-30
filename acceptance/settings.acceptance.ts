import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Machine, newMachine } from "./support/machine";
import { addOrder, approve, runOrder, showOrder } from "./support/operator-acts";
import { actions } from "./support/order-view";
import { buildTurn, happyPath } from "./support/scripts";
import { ACTION } from "./support/vocabulary";

setDefaultTimeout(180_000);

let machine: Machine;
afterEach(() => machine?.close());

function projectSettings(m: Machine, settings: Record<string, unknown>): void {
  writeFileSync(join(m.repo, ".dim", "config.json"), `${JSON.stringify(settings)}\n`);
  m.git(["add", ".dim/config.json"]);
  m.git(["commit", "-q", "-m", "chore: change the project's settings"]);
}

function userSettings(m: Machine, settings: Record<string, unknown>): void {
  const dir = join(m.env.HOME as string, ".config", "dim");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(settings)}\n`);
}

async function reviewed(m: Machine): Promise<string> {
  const id = await addOrder(m.operator);
  await runOrder(m.operator, id);
  await approve(m.operator, id);
  await approve(m.operator, id);
  return id;
}

describe("settings", () => {
  test("an order follows the project's setting over the user's", async () => {
    machine = await newMachine();
    const m = machine;
    m.script(happyPath());
    userSettings(m, { ship: "pull-request" });
    const id = await reviewed(m);

    await approve(m.operator, id);

    expect((await showOrder(m.operator, id)).status).toBe("shipped");
    expect(m.git(["ls-tree", "--name-only", "main", "slice-1.txt"])).toBe("slice-1.txt");
  });

  test("a project whose settings do not say how it ships is not shipped", async () => {
    machine = await newMachine();
    const m = machine;
    m.script(happyPath());
    projectSettings(m, {});
    const id = await reviewed(m);
    const main = m.git(["rev-parse", "main"]);

    const stopped = await approve(m.operator, id);

    expect(stopped.ok).toBe(false);
    const order = await showOrder(m.operator, id);
    expect(order.status).toBe("running");
    expect(order.log.find((entry) => entry.action === ACTION.shipStopped)?.code).toBeString();
    expect(m.git(["rev-parse", "main"])).toBe(main);
  });

  test("a setting the factory does not know is refused", async () => {
    machine = await newMachine();
    const m = machine;
    m.script(happyPath());
    projectSettings(m, { ship: "trunk", shipping: "trunk" });

    const refused = await m.operator.dim([
      "order",
      "add",
      "--title",
      "Greet",
      "--request",
      "Add a greeting.",
    ]);

    expect(refused.ok).toBe(false);
    expect(refused.error?.code).toBeString();
    expect(JSON.stringify(refused.error)).toContain("shipping");
  });

  test("the settings are read from the default branch, not from an order's changes", async () => {
    machine = await newMachine();
    const m = machine;
    m.script({
      ...happyPath(),
      builder: [
        [
          { act: "write", path: ".dim/config.json", content: '{"ship":"pull-request"}\n' },
          { act: "commit", subject: "chore: ship through a pull request" },
          ...buildTurn(),
        ],
      ],
    });
    const id = await reviewed(m);

    await approve(m.operator, id);

    expect(actions(await showOrder(m.operator, id))).toContain(ACTION.shipLanded);
  });
});
