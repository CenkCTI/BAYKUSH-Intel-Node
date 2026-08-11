import type { ClassifiedFailure, CollectionFailureCode } from "../contracts/source.js";

interface CollectionFailureOptions extends ErrorOptions {
  retryAfterSeconds?: number;
}

export class CollectionFailure extends Error {
  readonly code: CollectionFailureCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(code: CollectionFailureCode, message: string, retryable: boolean, options: CollectionFailureOptions = {}) {
    super(message, options);
    this.name = "CollectionFailure";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export function classifyUnknownFailure(error: unknown): ClassifiedFailure {
  if (error instanceof CollectionFailure) {
    const failure: ClassifiedFailure = {
      code: error.code,
      retryable: error.retryable,
      message: safeFailureMessage(error.message),
    };
    if (error.retryAfterSeconds !== null) failure.retryAfterSeconds = error.retryAfterSeconds;
    return failure;
  }
  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", retryable: false, message: safeFailureMessage(error.message) };
  }
  return { code: "INTERNAL_ERROR", retryable: false, message: "Unknown internal collection failure" };
}

export function safeFailureMessage(message: string): string {
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 1_000) || "Collection failure";
}
