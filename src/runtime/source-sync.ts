import type { SourceAdapter } from "../contracts/source.js";
import { sourceDefinitionSchema } from "../contracts/source.js";
import { pool, withTransaction } from "../db/pool.js";

export async function syncSourceDefinitions(adapters: readonly SourceAdapter[]): Promise<void> {
  for (const adapter of adapters) {
    const definition = sourceDefinitionSchema.parse(adapter.definition);
    await withTransaction(async (client) => {
      const result = await client.query<{ id: string; enabled: boolean }>(
        `INSERT INTO source_definitions(
           source_key, display_name, provider_name, upstream_origin_key,
           source_class, observation_basis, authority_type, collection_mode,
           default_poll_interval_seconds, minimum_poll_interval_seconds,
           supports_historical_retrieval, recovery_strategy, historical_max_window_seconds,
           requires_auth, credential_kind, adapter_version, semantic_contract_version,
           license_class, commercial_use_status, redistribution_status,
           attribution_requirement, terms_reference, represents, does_not_represent,
           enabled_by_default, enabled
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$25
         )
         ON CONFLICT (source_key) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           provider_name = EXCLUDED.provider_name,
           upstream_origin_key = EXCLUDED.upstream_origin_key,
           source_class = EXCLUDED.source_class,
           observation_basis = EXCLUDED.observation_basis,
           authority_type = EXCLUDED.authority_type,
           collection_mode = EXCLUDED.collection_mode,
           default_poll_interval_seconds = EXCLUDED.default_poll_interval_seconds,
           minimum_poll_interval_seconds = EXCLUDED.minimum_poll_interval_seconds,
           supports_historical_retrieval = EXCLUDED.supports_historical_retrieval,
           recovery_strategy = EXCLUDED.recovery_strategy,
           historical_max_window_seconds = EXCLUDED.historical_max_window_seconds,
           requires_auth = EXCLUDED.requires_auth,
           credential_kind = EXCLUDED.credential_kind,
           adapter_version = EXCLUDED.adapter_version,
           semantic_contract_version = EXCLUDED.semantic_contract_version,
           license_class = EXCLUDED.license_class,
           commercial_use_status = EXCLUDED.commercial_use_status,
           redistribution_status = EXCLUDED.redistribution_status,
           attribution_requirement = EXCLUDED.attribution_requirement,
           terms_reference = EXCLUDED.terms_reference,
           represents = EXCLUDED.represents,
           does_not_represent = EXCLUDED.does_not_represent,
           enabled_by_default = EXCLUDED.enabled_by_default,
           updated_at = now()
         RETURNING id, enabled`,
        [
          definition.sourceKey,
          definition.displayName,
          definition.providerName,
          definition.upstreamOriginKey,
          definition.sourceClass,
          definition.observationBasis,
          definition.authorityType,
          definition.collectionMode,
          definition.defaultPollIntervalSeconds,
          definition.minimumPollIntervalSeconds,
          definition.supportsHistoricalRetrieval,
          definition.recoveryStrategy,
          definition.historicalMaxWindowSeconds,
          definition.requiresAuth,
          definition.credentialKind,
          definition.adapterVersion,
          definition.semanticContractVersion,
          definition.licenseClass,
          definition.commercialUseStatus,
          definition.redistributionStatus,
          definition.attributionRequirement,
          definition.termsReference,
          definition.semanticBoundary.represents,
          definition.semanticBoundary.doesNotRepresent,
          definition.enabledByDefault,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error(`Failed to synchronize source definition ${definition.sourceKey}`);

      await client.query(
        `INSERT INTO source_schedule_state(source_definition_id, next_due_at)
         VALUES ($1, now())
         ON CONFLICT (source_definition_id) DO NOTHING`,
        [row.id],
      );
      await client.query(
        `INSERT INTO source_health(source_definition_id, health_status)
         VALUES ($1, $2)
         ON CONFLICT (source_definition_id) DO NOTHING`,
        [row.id, row.enabled ? "UNKNOWN" : "PAUSED"],
      );
      await client.query(
        `INSERT INTO normalization_jobs(raw_record_id, source_definition_id, normalization_version, state)
         SELECT r.id, r.source_definition_id, $2, 'QUEUED'
         FROM raw_source_records r
         WHERE r.source_definition_id = $1
         ON CONFLICT (raw_record_id, normalization_version) DO NOTHING`,
        [row.id, adapter.normalizationVersion],
      );
    });
  }
}

export async function listSourceStates(): Promise<Array<{
  sourceKey: string;
  displayName: string;
  enabled: boolean;
  healthStatus: string;
  nextDueAt: string | null;
  lastSuccessAt: string | null;
}>> {
  const result = await pool.query<{
    source_key: string;
    display_name: string;
    enabled: boolean;
    health_status: string;
    next_due_at: Date | null;
    last_success_at: Date | null;
  }>(
    `SELECT d.source_key, d.display_name, d.enabled,
            COALESCE(h.health_status, 'UNKNOWN') AS health_status,
            s.next_due_at, h.last_success_at
     FROM source_definitions d
     LEFT JOIN source_schedule_state s ON s.source_definition_id = d.id
     LEFT JOIN source_health h ON h.source_definition_id = d.id
     ORDER BY d.source_key`,
  );
  return result.rows.map((row) => ({
    sourceKey: row.source_key,
    displayName: row.display_name,
    enabled: row.enabled,
    healthStatus: row.health_status,
    nextDueAt: row.next_due_at?.toISOString() ?? null,
    lastSuccessAt: row.last_success_at?.toISOString() ?? null,
  }));
}
