# Source Admission — JVN_IPEDIA

## Decision

Status: `ADMITTED`

Policy: `jvn-ipedia-admission-v1`

Terms reviewed: 2026-08-14 (Europe/Warsaw)

Next review: 2026-11-14

## Analyst question

Which vulnerability countermeasure entries are newly published or updated through the official English JVN iPedia recent feeds?

## Official access

JVN iPedia publishes machine-readable JVNDBRSS feeds. NODE-5D uses two official recent surfaces:

- `JVNDBRSS-New` — newly published entries;
- `JVNDBRSS-Updated` — recent new/updated entries.

The source is polled hourly. Both feeds are fetched in one bounded work unit, parsed as RSS 1.0/JVNRSS XML, deduplicated by `sec:identifier`, and fingerprinted as one recent-surface snapshot.

## Canonical mapping

Record kind: `SECURITY_ADVISORY`

Canonical identity: JVN iPedia `sec:identifier`.

CVE references in `sec:references` become `CVE` entities when a valid CVE identifier is present. Title, description, publisher, source issue/update time, and structured references remain bounded facts.

Source `dcterms:issued` and `dcterms:modified` remain distinct from Node receipt time.

## Semantic boundary

Represents recent vulnerability countermeasure entries syndicated by JVN iPedia.

Does not represent a complete historical JVN iPedia corpus, exploitation confirmation, attack volume, victim count, organization exposure, remediation priority, business risk, or global threat level.

## Coverage and measurements

The recent feed is intentionally modeled as `LIVE_ONLY`. A long Node outage may exceed the publisher's recent surface. Therefore `measurementProjectionAllowed=false` in this admission revision.

The source may enrich CVE/advisory context, but its recent-feed count must not be presented as an authoritative national vulnerability-activity time series until a separate historical/coverage contract is admitted.

## Use constraints

JVN documents that its feed tools are available to private and corporate users and that syndicated information reflects vulnerability notes confirmed at syndication time; users should consult JVN or the relevant vendor for the latest information. The site does not present this content under an unrestricted redistribution license, so BAYKUSH records redistribution, derived-data publication, and public display as restricted.

## Security

- fixed HTTPS host/path for both feeds;
- bounded response size and timeout;
- parser rejects `DOCTYPE`/`ENTITY` declarations before XML parsing;
- XML entity processing disabled;
- strict identifier/title/link validation;
- deterministic dedupe and snapshot fingerprinting;
- no credentials;
- disabled by default.
