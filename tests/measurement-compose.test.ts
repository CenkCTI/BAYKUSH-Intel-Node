import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("NODE-3 measurement container boundary", () => {
  it("runs the measurement service without provider or CİTEM credentials", async () => {
    const compose = await readFile("docker-compose.node3.yml", "utf8");
    expect(compose).toContain("dist/measurement/main.js");
    expect(compose).toContain("MEASUREMENT_ENABLED");
    expect(compose).not.toContain("NVD_API_KEY");
    expect(compose).not.toContain("THREATFOX_AUTH_KEY");
    expect(compose).not.toContain("MALWAREBAZAAR_AUTH_KEY");
    expect(compose).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(compose).not.toContain("NEXT_PUBLIC_SUPABASE_URL");
  });
});
