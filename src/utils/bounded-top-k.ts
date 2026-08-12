export type QualityComparator<T> = (left: T, right: T) => number;

/**
 * Retains only the best K values while reading an unbounded input stream.
 * compareQuality(a, b) must return > 0 when a ranks ahead of b.
 * The heap root is always the worst retained value.
 */
export class BoundedTopK<T> {
  readonly #limit: number;
  readonly #compareQuality: QualityComparator<T>;
  readonly #heap: T[] = [];

  constructor(limit: number, compareQuality: QualityComparator<T>) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("BoundedTopK limit must be a positive integer");
    this.#limit = limit;
    this.#compareQuality = compareQuality;
  }

  get size(): number {
    return this.#heap.length;
  }

  offer(value: T): void {
    if (this.#heap.length < this.#limit) {
      this.#heap.push(value);
      this.#siftUp(this.#heap.length - 1);
      return;
    }
    const worst = this.#heap[0];
    if (worst === undefined || this.#compareQuality(value, worst) <= 0) return;
    this.#heap[0] = value;
    this.#siftDown(0);
  }

  valuesBestFirst(): T[] {
    return [...this.#heap].sort((left, right) => this.#compareQuality(right, left));
  }

  #siftUp(startIndex: number): void {
    let index = startIndex;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const currentValue = this.#heap[index];
      const parentValue = this.#heap[parent];
      if (currentValue === undefined || parentValue === undefined) return;
      if (this.#compareQuality(currentValue, parentValue) >= 0) return;
      this.#heap[index] = parentValue;
      this.#heap[parent] = currentValue;
      index = parent;
    }
  }

  #siftDown(startIndex: number): void {
    let index = startIndex;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      const worstValue = this.#heap[worst];
      const leftValue = this.#heap[left];
      const rightValue = this.#heap[right];
      if (worstValue === undefined) return;
      if (leftValue !== undefined && this.#compareQuality(leftValue, this.#heap[worst] as T) < 0) worst = left;
      if (rightValue !== undefined && this.#compareQuality(rightValue, this.#heap[worst] as T) < 0) worst = right;
      if (worst === index) return;
      const current = this.#heap[index] as T;
      this.#heap[index] = this.#heap[worst] as T;
      this.#heap[worst] = current;
      index = worst;
    }
  }
}
