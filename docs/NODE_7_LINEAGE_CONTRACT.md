# NODE-7 Lineage & Related-Record Contract

## Related-record basis

NODE-7 v1 related records use only `EXACT_CANONICAL_ENTITY_OVERLAP`. A record is related when its canonical `entities` array contains the same entity `kind` and canonical `key` as the subject.

The following are deliberately not implicit relationships:

- subdomain -> parent domain;
- URL -> host/domain;
- IP -> domain through current DNS;
- malware-family similarity;
- product-family or vulnerability-family similarity;
- text/name similarity.

Those require future explicit relationship models with their own provenance.

## Bounded lineage graph

The lineage service is not an arbitrary recursive graph endpoint. It accepts:

- exact entity type/key;
- depth 1..3;
- at most 100 nodes;
- at most 200 edges.

Safe node classes are:

- ENTITY;
- SOURCE_DEFINITION;
- RAW_SOURCE_RECORD metadata;
- CANONICAL_RECORD;
- ENTITY_OBSERVATION_REVISION;
- ENTITY_HISTORY_REVISION;
- ACTIVITY_BUCKET_REVISION;
- CONVERGENCE_FINDING_REVISION.

Raw source payloads are not returned through lineage. Raw-record nodes expose only bounded provenance metadata such as source record id, payload fingerprint and source/effective timestamps.

## Traversal

The expected evidence path is:

`finding -> activity revision -> entity observation -> canonical record -> raw record -> source definition`

Current bounded graph output may collapse or omit intermediate nodes when the node limit is reached, but it must never invent an edge or source relationship.

## Security

Lineage does not accept a URL, SQL expression, arbitrary relation name, arbitrary recursion depth, or provider request. It is a read-only projection over already-persisted Node state.
