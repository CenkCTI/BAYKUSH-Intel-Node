import type { QueuedStreamMessage } from "./contracts.js";

export class BoundedStreamQueue {
  readonly #items: QueuedStreamMessage[] = [];
  #bytes = 0;
  constructor(readonly maxMessages: number, readonly maxBytes: number) {
    if (!Number.isInteger(maxMessages) || maxMessages < 1) throw new Error("maxMessages must be positive");
    if (!Number.isInteger(maxBytes) || maxBytes < 1024) throw new Error("maxBytes must be at least 1 KiB");
  }
  get size(): number { return this.#items.length; }
  get bytes(): number { return this.#bytes; }
  push(item: QueuedStreamMessage): boolean {
    if (item.bytes > this.maxBytes || this.#items.length + 1 > this.maxMessages || this.#bytes + item.bytes > this.maxBytes) return false;
    this.#items.push(item); this.#bytes += item.bytes; return true;
  }
  drain(maxMessages: number, maxBytes: number): QueuedStreamMessage[] {
    const output: QueuedStreamMessage[] = []; let bytes = 0;
    while (this.#items.length && output.length < maxMessages) {
      const next = this.#items[0]; if (!next) break;
      if (output.length > 0 && bytes + next.bytes > maxBytes) break;
      this.#items.shift(); this.#bytes -= next.bytes; bytes += next.bytes; output.push(next);
    }
    return output;
  }
}
