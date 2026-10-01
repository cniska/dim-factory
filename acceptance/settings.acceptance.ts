import { describe, expect, test } from "bun:test";
import { refusal } from "./support/dim-output";
import { machines, PROJECT_SETTINGS } from "./support/machine";
import { approve, reviewed, showOrder } from "./support/operator-acts";
import { actions, entryOf } from "./support/order-view";
import { BUILD_ARTIFACT, happyPath, sliceActs } from "./support/scripts";
import { ACTION } from "./support/vocabulary";

const start = machines();

describe("settings", () => {
  test("a project whose settings do not say how it ships is not shipped", async () => {
    const m = await start({ script: happyPath() });
    m.projectSettings({});
    const id = await reviewed(m.operator);
    const main = m.git(["rev-parse", "main"]);

    const stopped = await approve(m.operator, id);

    expect(refusal(stopped).code).toBeString();
    const order = await showOrder(m.operator, id);
    expect(order.status).toBe("running");
    expect(entryOf(order, ACTION.shipStopped).code).toBeString();
    expect(m.git(["rev-parse", "main"])).toBe(main);
  });

  test("a setting the factory does not know is refused", async () => {
    const m = await start({ script: happyPath() });
    m.projectSettings({ ...PROJECT_SETTINGS, shipping: "default-branch" });

    const refused = await m.operator.dim([
      "order",
      "add",
      "--title",
      "Greet",
      "--description",
      "Add a greeting.",
    ]);

    expect(refusal(refused).code).toBeString();
    expect(JSON.stringify(refusal(refused))).toContain("shipping");
  });

  test("the settings are read from the default branch, not from an order's changes", async () => {
    const m = await start({
      script: {
        ...happyPath(),
        builder: [
          [
            { act: "write", path: ".dim/config.json", content: "{}\n" },
            ...sliceActs(1),
            ...sliceActs(2),
            { act: "build-return", artifact: BUILD_ARTIFACT },
          ],
        ],
      },
    });
    const id = await reviewed(m.operator);

    await approve(m.operator, id);

    expect(actions(await showOrder(m.operator, id))).toContain(ACTION.shipLanded);
  });
});
