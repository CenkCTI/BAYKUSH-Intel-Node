# NODE-5B1 Source Slice

This stacked draft PR is the first source-specific implementation after the NODE-5A admission foundation.

The slice must preserve the existing provider-independent collection, immutable raw evidence, canonical normalization, coverage and measurement architecture. The source starts disabled, uses an explicit versioned admission policy, creates no provider-specific database tables, and is not eligible for merge until the full NODE validation suite is green.

Measurement contracts remain a later NODE-5H responsibility so source collection semantics are accepted before new activity-series definitions are published.
