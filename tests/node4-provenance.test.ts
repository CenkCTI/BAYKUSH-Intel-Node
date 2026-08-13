import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMeasurementRegistration } from "../src/measurement/registry.js";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../src/db/pool.js", () => ({
  pool: { query },
  withTransaction: vi.fn(),
}));

import { handleMeasurementProvenanceApi } from "../src/measurement/provenance-api.js";

const REVISION_ID = "11111111-1111-4111-8111-111111111111";
const MEASUREMENT_KEY = "vulnerability.nvd.publications";

function responseCapture(): { response: ServerResponse; body: () => unknown } {
  let serialized = "";
  const response = {
    statusCode: 0,
    setHeader: vi.fn(),
    end: vi.fn((value: string) => { serialized = value; }),
  } as unknown as ServerResponse;
  return { response, body: () => JSON.parse(serialized) as unknown };
}

describe("NODE-4 measurement provenance semantics", () => {
  beforeEach(() => query.mockReset());

  it("returns semantic metadata from the registered measurement contract", async () => {
    const registration = getMeasurementRegistration(MEASUREMENT_KEY);
    expect(registration).not.toBeNull();
    query
      .mockResolvedValueOnce({ rows: [{
        id: REVISION_ID,
        measurement_calculation_id: "22222222-2222-4222-8222-222222222222",
        bucket_start: new Date("2026-08-12T00:00:00.000Z"),
        bucket_end: new Date("2026-08-13T00:00:00.000Z"),
        calculated_at: new Date("2026-08-13T00:05:00.000Z"),
        input_fingerprint: "input-fingerprint",
        coverage_input_fingerprint: "coverage-fingerprint",
        revision_number: 1,
        measurement_key: MEASUREMENT_KEY,
        contract_version: registration?.definition.contractVersion,
        calculation_version: registration?.calculation.calculationVersion,
      }] })
      .mockResolvedValueOnce({ rows: [] });

    const captured = responseCapture();
    const handled = await handleMeasurementProvenanceApi(
      { method: "GET" } as IncomingMessage,
      captured.response,
      new URL(`http://node.test/v1/techint/provenance/measurement/${REVISION_ID}`),
    );

    expect(handled).toBe(true);
    expect(captured.response.statusCode).toBe(200);
    const body = captured.body() as { data: { measurement: unknown }; meta: unknown };
    expect(body.data.measurement).toEqual({
      key: MEASUREMENT_KEY,
      contractVersion: registration?.definition.contractVersion,
      calculationVersion: registration?.calculation.calculationVersion,
      unit: registration?.definition.unit,
      timeAxis: registration?.definition.primaryTimeAxis,
      populationProfile: registration?.definition.populationProfile,
      represents: registration?.definition.represents,
      doesNotRepresent: registration?.definition.doesNotRepresent,
    });
    expect(body.meta).toMatchObject({ limit: 100 });
    expect(JSON.stringify(body)).not.toContain("rawPayload");
  });
});
