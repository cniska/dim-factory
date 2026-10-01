import { type Command, UsageError } from "./cli-contract";
import { openFactoryReadOnly } from "./factory-db";
import { OrderId } from "./order-contract";
import { orderState } from "./order-ops";
import { clearTrace, followTrace } from "./trace-ops";

const USAGE = "usage: dim trace <order> | dim trace clear";

export const traceCommand: Command = {
  name: "trace",
  usage: USAGE,
  summary: "follow an order's factory steps as JSONL until stopped, or empty the trace",
  raw: (args) => args[0] !== "clear",
  run(args) {
    const [target, ...rest] = args;
    if (target === undefined || rest.length > 0) throw new UsageError(USAGE);
    if (target === "clear") {
      clearTrace(process.env);
      return { cleared: true };
    }
    const order = OrderId.safeParse(target);
    if (!order.success) throw new UsageError(USAGE);
    const db = openFactoryReadOnly();
    try {
      orderState(db, order.data);
    } finally {
      db.close();
    }
    return followTrace(order.data, process.env, (line) => process.stdout.write(`${line}\n`));
  },
};
