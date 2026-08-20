# NODE-7 CITEM Consumer Contract

## Authority

BAYKUSH Intelligence Node is the authority for public/global technical discovery state. CITEM is a read-only analyst client and must not recompute convergence, novelty, composition, geography or routing context from raw source records.

## Endpoints

- `GET /v1/techint/discovery`
- `GET /v1/techint/convergence`
- `GET /v1/techint/discovery/new-entities`
- `GET /v1/techint/discovery/composition`
- `GET /v1/techint/discovery/top-movers`
- `GET /v1/techint/geography/map`
- `GET /v1/techint/entities/{encodedEntityKey}/related-records?entityType=...`
- `GET /v1/techint/entities/{encodedEntityKey}/lineage?entityType=...`
- `GET /v1/techint/entities/{encodedEntityKey}/geography?entityType=...`
- `GET /v1/techint/entities/{encodedEntityKey}/infrastructure-context?entityType=...`

All routes live under the existing authenticated `/v1/techint/*` service boundary.

## Bounds

- discovery/convergence/geography range: maximum 30 days;
- standard list page: maximum 100 rows;
- lineage: depth 1..3, maximum 100 nodes and 200 edges;
- geography map: country aggregate, maximum 250 countries;
- routing infrastructure context: canonical IP only, maximum 24 hours and 500 returned minute contexts.

## Failure domains

CITEM must query NODE-7 discovery separately from core measurement and routing-lane requests. A geography, discovery or lineage failure must not make Vulnerability/Exploitation, Malware/IOC or Internet Infrastructure unavailable.

## Semantics CITEM must preserve

- source-system overlap is not independent multi-origin convergence;
- convergence is not causation or attack evidence;
- `DATE` precision is not hour-level concurrency;
- new entity uses effective first-seen time, not Node ingestion time;
- historical acquisition is not current novelty;
- composition expansion is not a threat/risk score;
- absence is not removal unless a future coverage-aware contract explicitly says so;
- observed infrastructure geography is not attacker origin;
- reported target and reported activity are separate geo classes;
- current IP geolocation is never silently backdated;
- ASN context is not physical location;
- BGP announcement is not attack;
- BGP withdrawal is not outage;
- routing context is not hijack detection.

## Attribution

Where `IPINFO_LITE` is the geography assertion basis, public presentation must preserve the Node-provided attribution requirement. RIPE routing context must preserve RIPE RIS attribution.

## Security

CITEM continues to call Node only from the server-side `baykush-node` client. The browser must never receive the Node bearer token, IPinfo token, provider URLs containing secrets, raw source payloads or arbitrary provider lookup capability.
