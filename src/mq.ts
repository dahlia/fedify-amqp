import type {
  MessageQueue,
  MessageQueueEnqueueOptions,
  MessageQueueListenOptions,
} from "@fedify/fedify";
// @deno-types="npm:@types/amqplib@^0.10.5"
import type { Channel, Connection } from "amqplib";
import { Buffer } from "node:buffer";

/**
 * Options for {@link AmqpMessageQueue}.
 */
export interface AmqpMessageQueueOptions {
  /**
   * The name of the queue to use.  Defaults to `"fedify_queue"`.
   * @default `"fedify_queue"`
   */
  queue?: string;

  /**
   * The prefix to use for the delayed queue.  Defaults to `"fedify_delayed_"`.
   * Defaults to `"fedify_delayed_"`.
   * @default `"fedify_delayed_"`
   */
  delayedQueuePrefix?: string;

  /**
   * Whether the queue will survive a broker restart.  Defaults to `true`.
   * @default `true`
   */
  durable?: boolean;
}

/**
 * A message queue that uses AMQP.
 *
 * @example
 * ``` typescript
 * import { createFederation } from "@fedify/fedify";
 * import { AmqpMessageQueue } from "@fedify/amqp";
 * import { connect } from "amqplib";
 *
 * const federation = createFederation({
 *   queue: new AmqpMessageQueue(await connect("amqp://localhost")),
 *   // ... other configurations
 * });
 * ```
 */
export class AmqpMessageQueue implements MessageQueue {
  #connection: Connection;
  #queue: string;
  #delayedQueuePrefix: string;
  #durable: boolean;
  #senderChannel?: Channel;

  /**
   * Creates a new `AmqpMessageQueue`.
   * @param connection A connection to the AMQP server.
   * @param options Options for the message queue.
   */
  constructor(
    connection: Connection,
    options: AmqpMessageQueueOptions = {},
  ) {
    this.#connection = connection;
    this.#queue = options.queue ?? "fedify_queue";
    this.#delayedQueuePrefix = options.delayedQueuePrefix ?? "fedify_delayed_";
    this.#durable = options.durable ?? true;
  }

  async #prepareQueue(channel: Channel): Promise<void> {
    await channel.assertQueue(this.#queue, {
      durable: this.#durable,
    });
  }

  async #getSenderChannel(): Promise<Channel> {
    if (this.#senderChannel != null) return this.#senderChannel;
    const channel = await this.#connection.createChannel();
    this.#senderChannel = channel;
    this.#prepareQueue(channel);
    return channel;
  }

  async enqueue(
    // deno-lint-ignore no-explicit-any
    message: any,
    options?: MessageQueueEnqueueOptions,
  ): Promise<void> {
    const channel = await this.#getSenderChannel();
    const delay = options?.delay?.total("millisecond");
    let queue: string;
    if (delay == null || delay <= 0) {
      queue = this.#queue;
    } else {
      const delayStr = delay.toLocaleString("en", { useGrouping: false });
      queue = this.#delayedQueuePrefix + delayStr;
      await channel.assertQueue(queue, {
        autoDelete: true,
        durable: this.#durable,
        deadLetterExchange: "",
        deadLetterRoutingKey: this.#queue,
        messageTtl: delay,
      });
    }
    channel.sendToQueue(
      queue,
      Buffer.from(JSON.stringify(message), "utf-8"),
      {
        persistent: this.#durable,
        contentType: "application/json",
      },
    );
  }

  async listen(
    // deno-lint-ignore no-explicit-any
    handler: (message: any) => void | Promise<void>,
    options: MessageQueueListenOptions = {},
  ): Promise<void> {
    const channel = await this.#connection.createChannel();
    await this.#prepareQueue(channel);
    await channel.prefetch(1);
    const reply = await channel.consume(this.#queue, (msg) => {
      if (msg == null) return;
      const message = JSON.parse(msg.content.toString("utf-8"));
      const result = handler(message);
      if (result instanceof Promise) {
        result.finally(() => channel.ack(msg));
      } else {
        channel.ack(msg);
      }
    }, {
      noAck: false,
    });
    return await new Promise((resolve) => {
      options.signal?.addEventListener("abort", () => {
        channel.cancel(reply.consumerTag).then(() => {
          channel.close().then(() => resolve());
        });
      });
    });
  }
}
