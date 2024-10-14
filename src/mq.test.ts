import { assertEquals, assertGreater } from "@std/assert";
import { delay } from "@std/async/delay";
// @deno-types="npm:@types/amqplib"
import { connect, type Connection } from "amqplib";
import { AmqpMessageQueue } from "./mq.ts";

function getConnection(): Promise<Connection> {
  const url = Deno.env.get("AMQP_URL");
  return connect(url ?? "amqp://localhost");
}

Deno.test("AmqpMessageQueue", async (t) => {
  const conn = await getConnection();
  const conn2 = await getConnection();
  const queue = `fedify_queue_${Math.random().toString(36).slice(5)}`;
  const delayedQueuePrefix = `fedify_delayed_${
    Math.random().toString(36).slice(5)
  }_`;
  const mq = new AmqpMessageQueue(conn, { queue, delayedQueuePrefix });
  const mq2 = new AmqpMessageQueue(conn2, { queue, delayedQueuePrefix });

  const messages: string[] = [];
  const controller = new AbortController();
  const listening = mq.listen((message: string) => {
    messages.push(message);
  }, { signal: controller.signal });
  const listening2 = mq2.listen((message: string) => {
    messages.push(message);
  }, { signal: controller.signal });

  await t.step("enqueue()", async () => {
    await mq.enqueue("Hello, world!");
  });

  await waitFor(() => messages.length > 0, 15_000);

  await t.step("listen()", () => {
    assertEquals(messages, ["Hello, world!"]);
  });

  let started = 0;
  await t.step("enqueue() with delay", async () => {
    started = Date.now();
    await mq.enqueue(
      "Delayed message",
      { delay: Temporal.Duration.from({ seconds: 3 }) },
    );
  });

  await waitFor(() => messages.length > 1, 15_000);

  await t.step("listen() with delay", () => {
    assertEquals(messages, ["Hello, world!", "Delayed message"]);
    assertGreater(Date.now() - started, 3_000);
  });

  controller.abort();
  await listening;
  await listening2;

  await conn.close();
  await conn2.close();
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    await delay(500);
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timeout");
    }
  }
}
