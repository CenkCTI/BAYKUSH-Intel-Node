# NODE-7 Geography Policy

## Classes

NODE-7 geography has exactly three semantic classes:

- `OBSERVED_INFRASTRUCTURE_LOCATION` — location context attached to observed technical infrastructure;
- `REPORTED_TARGET` — a source explicitly reports a target geography;
- `REPORTED_ACTIVITY` — a source explicitly reports activity in a geography.

These classes are never collapsed into attacker origin or actor nationality.

## IPinfo Lite provider boundary

NODE-7 v1 admits IPinfo Lite as an optional enrichment provider for canonical IP entities already present in BAYKUSH. The integration uses the authenticated Lite API and persists normalized derived assertions, not the raw provider response.

The admitted v1 fields are country/continent and basic ASN context. IPinfo Lite is country-level for this integration; city, region and coordinates are not synthesized. ASN organization fields are kept in `provider_context` and explicitly do not represent physical infrastructure location.

Public presentation must preserve the configured IPinfo attribution requirement.

## Temporal policy

IPinfo Lite API lookups are `CURRENT_SNAPSHOT_ONLY`. `observed_time` is the provider lookup time. The result must never be backdated to a canonical source record's historical timestamp.

If a historical source says an IP was observed in 2024 and BAYKUSH performs a Lite lookup in 2026, the geography assertion means only that the provider returned that country-level location in 2026.

## No arbitrary lookup endpoint

The geography worker can enrich only exact canonical IP entity keys selected from persisted `entity_history_heads`. Node read APIs do not accept an arbitrary IP and trigger provider traffic. The provider URL has a fixed `https://api.ipinfo.io` origin and the path is derived only from a validated literal IPv4/IPv6 address.

## Source admission

`IPINFO_LITE` remains disabled for the generic source scheduler. NODE-7 geography checks the current source-admission revision before enrichment and requires collection + derived-data permission. The provider is reviewed independently of technical implementation so licensing/attribution changes can pause enrichment without changing canonical entity truth.

## Unknown/bogon response

A successful lookup without country-level location creates a lookup receipt but not a fabricated location assertion. Unknown geography therefore remains unknown rather than becoming an empty/zero country.
