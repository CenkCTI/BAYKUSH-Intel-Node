# Source Admission — RIPE RIS BGP

Status: `ADMITTED` but disabled by default.

## Value question

What routing changes are observed by the configured RIPE RIS route-collector population?

## Access

Production live acquisition uses only the fixed RIPE RIS Live WebSocket endpoint. Historical/recovery acquisition may use official RIPE RIS MRT archives. Both channels share the upstream origin `RIPE_RIS` and must never be counted as independent corroboration.

## Allowed projections

- collection: yes;
- routing projection: yes;
- measurement projection: yes;
- public display: restricted pending current RIPE commercial/public-display review.

## Retention

Raw stream payload retention is intentionally short and bounded. Segment manifests, hashes and derived routing measurements may be retained longer. Retention and public redistribution must continue to satisfy current RIPE terms.

## Semantic boundary

RIS observations represent routing messages visible to the selected collector population. They do not independently establish malicious routing, hijacking, outages, attacks, victims, attacker origin, business impact or global threat state.

## Operator constraints

The stream endpoint is server-owned and not user configurable. Observer populations are versioned. Backpressure or lost intervals fail closed into explicit coverage gaps. Historical MRT recovery repairs availability without fabricating live coverage.
