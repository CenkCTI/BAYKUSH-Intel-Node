import { describe, expect, it } from "vitest";
import { CollectionFailure, classifyUnknownFailure, safeFailureMessage } from "../src/runtime/failure.js";

describe("collection failure taxonomy", () => {
  it("preserves controlled failure codes", () => {
    const failure = classifyUnknownFailure(new CollectionFailure("RATE_LIMITED", "slow down", true));
    expect(failure).toEqual({ code: "RATE_LIMITED", retryable: true, message: "slow down" });
  });

  it("sanitizes bounded messages", () => {
    expect(safeFailureMessage("secret-looking\nmultiline\tmessage")).toBe("secret-looking multiline message");
    expect(safeFailureMessage("x".repeat(2_000))).toHaveLength(1_000);
  });
});
