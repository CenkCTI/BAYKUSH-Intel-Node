import { describe, expect, it } from "vitest";
import { admissionPolicyRegistry } from "../src/sources/admission/registry.js";
import { createMitreAttackEnterpriseAdapter, normalizeMitreAttackPattern } from "../src/sources/mitre-attack-enterprise.js";

const technique = {
  type: "attack-pattern",
  id: "attack-pattern--00000000-0000-4000-8000-000000000001",
  created: "2026-01-01T00:00:00Z",
  modified: "2026-08-01T00:00:00Z",
  name: "Fixture Technique",
  description: "Fixture context only",
  revoked: false,
  x_mitre_deprecated: false,
  x_mitre_version: "1.0",
  x_mitre_is_subtechnique: false,
  x_mitre_platforms: ["Windows"],
  external_references: [{ source_name: "mitre-attack", external_id: "T9999", url: "https://attack.mitre.org/techniques/T9999/" }],
  kill_chain_phases: [{ kill_chain_name: "mitre-attack", phase_name: "execution" }],
};

function jsonFetch(payload: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

describe("MITRE ATT&CK Enterprise context source", () => {
  it("normalizes a technique as context knowledge rather than activity", () => {
    const canonical = normalizeMitreAttackPattern({ kind: "MITRE_ATTACK_PATTERN", source: technique })[0];
    expect(canonical?.recordKind).toBe("CONTEXT_KNOWLEDGE");
    expect(canonical?.entities).toContainEqual({ kind: "ATTACK_TECHNIQUE", key: "T9999", label: "T9999 — Fixture Technique" });
  });

  it("preserves STIX created and modified time separately", async () => {
    const adapter = createMitreAttackEnterpriseAdapter({ fetchImpl: jsonFetch({ type: "bundle", id: "bundle--fixture", objects: [technique] }) });
    const result = await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
    expect(result.records).toHaveLength(2);
    expect(adapter.identifyRawRecord(result.records[0])).toBe(technique.id);
    expect(adapter.extractTimes(result.records[0])).toEqual({ publishedAt: technique.created, effectiveAt: technique.created, upstreamUpdatedAt: technique.modified });
  });

  it("is idempotent for an unchanged snapshot", async () => {
    const adapter = createMitreAttackEnterpriseAdapter({ fetchImpl: jsonFetch({ type: "bundle", id: "bundle--fixture", objects: [technique] }) });
    const first = await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
    const second = await adapter.fetch({ work: first.nextCheckpoint, signal: new AbortController().signal });
    expect(second.records).toEqual([]);
  });

  it("keeps ATT&CK out of measurement projection", () => {
    const adapter = createMitreAttackEnterpriseAdapter({ fetchImpl: jsonFetch({ type: "bundle", objects: [] }) });
    const admission = admissionPolicyRegistry.get("MITRE_ATTACK_ENTERPRISE");
    expect(adapter.definition.sourceClass).toBe("CONTEXT_KNOWLEDGE");
    expect(adapter.definition.semanticBoundary.doesNotRepresent).toContain("global technique usage");
    expect(admission?.canonicalProjectionAllowed).toBe(true);
    expect(admission?.measurementProjectionAllowed).toBe(false);
  });
});
