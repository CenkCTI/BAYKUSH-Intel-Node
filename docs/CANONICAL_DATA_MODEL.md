# Canonical Data Model

## 1. Purpose

The Node must preserve source-native truth while exposing a stable, module-neutral representation that can feed CİTEM today and ANLAK later.

The canonical model is therefore an evidence envelope, not a universal ontology and not an analyst conclusion.

## 2. Layers

The data model is intentionally layered:

1. source payload;
2. raw source record;
3. canonical evidence envelope;
4. module projection;
5. derived measurements/relationships;
6. analyst workspace outside the global Node.

No layer may erase the provenance necessary to reach the layer below it.

## 3. Raw source record

A raw record should preserve at least:

- Node-generated raw-record ID;
- `source_key`;
- deterministic source-record identity when available;
- upstream origin;
- collection-run/work-unit reference;
- receipt timestamp;
- upstream publication/effective/update timestamps when supplied;
- payload hash;
- source URL/reference when appropriate;
- adapter version;
- source schema/version evidence when known;
- original payload or policy-approved faithful representation.

Raw records are immutable observations of what the Node received. An upstream update creates a new revision/observation rather than silently rewriting history.

## 4. Canonical Evidence Envelope

V1 envelope fields:

```text
canonical_id
canonical_key
record_kind

source_key
upstream_origin_key
source_record_id
raw_record_id

received_at
published_at?
effective_at?
upstream_updated_at?

entities[]
facts[]
references[]

semantic_boundary
normalization_version
created_at
```

Optional fields remain nullable. Unknown fields must not be converted to empty factual assertions.

## 5. Canonical record kinds

NODE-0 defines a small initial controlled set:

- `VULNERABILITY_RECORD`;
- `KNOWN_EXPLOITED_VULNERABILITY`;
- `EXPLOIT_PROBABILITY_SCORE`;
- `IOC_REPORT`;
- `MALWARE_SAMPLE_RECORD`;
- `SECURITY_ADVISORY`;
- `CERT_CSIRT_PUBLICATION`;
- `THREAT_RESEARCH_REPORT`;
- `INFRASTRUCTURE_OBSERVATION`;
- `CONTEXT_KNOWLEDGE`;
- `UNKNOWN`.

The set may expand under a versioned contract. Adapters must not invent arbitrary record-kind strings.

## 6. Canonical entities

The envelope may reference typed entities without forcing full ontology unification.

Initial entity kinds may include:

- `CVE`;
- `IP`;
- `DOMAIN`;
- `URL`;
- `HASH`;
- `MALWARE`;
- `VENDOR`;
- `PRODUCT`;
- `PACKAGE`;
- `ASN`;
- `CERTIFICATE`;
- `ATTACK_TECHNIQUE`;
- `ORGANIZATION`;
- `COUNTRY`;
- `SECTOR`;
- `REPORT`.

Entity assertions carry source/provenance context. Canonical entity normalization does not imply identity confidence beyond deterministic normalization rules.

## 7. Facts

Facts are bounded, source-supported statements extracted from a source record.

A fact must contain enough structure to identify:

- predicate/type;
- value or referenced entity;
- source basis;
- raw provenance;
- effective time when applicable;
- extraction/normalization version.

Facts are not analyst judgements. A future analyst assertion belongs in CİTEM/ANLAK workspaces or a separately typed assertion layer.

## 8. Revisions

The Node must distinguish:

- a duplicate delivery of the same source state;
- an upstream revision/update;
- a new observation about the same canonical subject.

Deterministic payload/source-state fingerprints should make identical redelivery idempotent while allowing real revisions to remain historically visible.

## 9. Module projections

### CİTEM TechINT projection

May derive:

- Technical Signals;
- IOC/vulnerability/malware/infrastructure entities;
- observations and revisions;
- source relationships;
- technical measurements;
- coverage-aware activity history.

### ANLAK OSINT projection — later

May derive:

- events;
- actors/organizations;
- countries/regions;
- sectors;
- claims;
- political/economic/energy context;
- strategic relationships.

The canonical envelope must not prematurely encode strategic interpretation to support a future ANLAK use case.

## 10. Provenance invariant

For every exposed canonical or derived record, the Node must be able to answer:

```text
Where did this value come from?
Which source record supported it?
When did the Node receive it?
What time did the source assign to it?
Which normalization/version produced it?
```

If that chain cannot be reconstructed, the derived value is not production-grade Node data.

## 11. AI boundary

AI may later summarize or assist with selected canonical records, but it cannot:

- create source timestamps;
- rewrite source identity;
- silently change canonical facts;
- override deterministic provenance;
- promote a report into direct observation;
- create attribution truth.

Any AI-derived statement must remain a separate, explicitly labelled derivative output.