import type { PoolClient } from "pg";
import { retractMeasurementFactByIdentity } from "../projection/retractions.js";
import type {
  AcquisitionBasis,
  CanonicalProjectionInput,
} from "../projection/types.js";
import { acquisitionBasis, sha256 } from "../projection/utils.js";
import { measurementSourceProjectors } from "../sources/registry.js";

export interface ChangedEntityHistory {
  entityKey: string;
  entityType: string;
  firstSeenTime: string | null;
  firstSeenDate: string | null;
  firstSourceDefinitionId: string;
  firstSourceKey: string;
  historyFingerprint: string;
  acquisitionBasis: AcquisitionBasis;
}

function noveltyMeasurement(
  sourceKey: string,
  entityType: string,
  entityKey: string,
): string | null {
  if (
    sourceKey === "THREATFOX"
    && ["IP", "DOMAIN", "URL", "HASH"].includes(entityType)
  ) {
    return "ioc.threatfox.first_seen_indicators";
  }
  if (
    sourceKey === "MALWAREBAZAAR"
    && entityType === "HASH"
    && entityKey.startsWith("sha256:")
  ) {
    return "malware.malwarebazaar.first_seen_hashes";
  }
  return null;
}

async function recomputeEntityHistory(input: {
  client: PoolClient;
  entityType: string;
  entityKey: string;
  acquisitionBasis: AcquisitionBasis;
  canonicalRecordId: string;
}): Promise<ChangedEntityHistory | null> {
  const observations = await input.client.query<{
    observation_key: string;
    current_revision_id: string;
    source_definition_id: string;
    source_key: string;
    observed_time: Date | null;
    observed_date: string | null;
  }>(
    `SELECT head.observation_key,head.current_revision_id,
            head.source_definition_id,source.source_key,
            head.observed_time,head.observed_date::text
     FROM entity_observation_heads head
     JOIN source_definitions source ON source.id=head.source_definition_id
     WHERE head.entity_type=$1 AND head.entity_key=$2 AND head.state='ACTIVE'
     ORDER BY COALESCE(head.observed_time,head.observed_date::timestamptz),
              head.observation_key`,
    [input.entityType, input.entityKey],
  );

  const current = await input.client.query<{
    current_revision_id: string;
    revision_number: number;
    input_fingerprint: string;
    first_source_definition_id: string;
    first_source_key: string;
  }>(
    `SELECT head.current_revision_id,revision.revision_number,
            revision.input_fingerprint,head.first_source_definition_id,
            source.source_key AS first_source_key
     FROM entity_history_heads head
     JOIN entity_history_revisions revision ON revision.id=head.current_revision_id
     JOIN source_definitions source ON source.id=head.first_source_definition_id
     WHERE head.entity_type=$1 AND head.entity_key=$2
     FOR UPDATE OF head`,
    [input.entityType, input.entityKey],
  );
  const prior = current.rows[0];
  const rows = observations.rows;

  if (rows.length === 0) {
    if (prior) {
      const previousNovelty = noveltyMeasurement(
        prior.first_source_key,
        input.entityType,
        input.entityKey,
      );
      if (previousNovelty) {
        await retractMeasurementFactByIdentity({
          client: input.client,
          measurementKey: previousNovelty,
          identity: { entityType: input.entityType, entityKey: input.entityKey },
          sourceDefinitionId: prior.first_source_definition_id,
          canonicalRecordId: input.canonicalRecordId,
          reason: "ENTITY_HISTORY_NO_LONGER_ACTIVE",
        });
      }
      await input.client.query(
        `DELETE FROM entity_history_heads
         WHERE entity_type=$1 AND entity_key=$2`,
        [input.entityType, input.entityKey],
      );
    }
    return null;
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return null;

  const sourceCount = new Set(rows.map((row) => row.source_definition_id)).size;
  const fingerprint = sha256(
    rows.map((row) => ({
      observationKey: row.observation_key,
      revisionId: row.current_revision_id,
      sourceDefinitionId: row.source_definition_id,
      observedTime: row.observed_time?.toISOString() ?? null,
      observedDate: row.observed_date,
    })),
  );
  if (prior?.input_fingerprint === fingerprint) return null;

  if (prior) {
    const previousNovelty = noveltyMeasurement(
      prior.first_source_key,
      input.entityType,
      input.entityKey,
    );
    const nextNovelty = noveltyMeasurement(
      first.source_key,
      input.entityType,
      input.entityKey,
    );
    if (previousNovelty && previousNovelty !== nextNovelty) {
      await retractMeasurementFactByIdentity({
        client: input.client,
        measurementKey: previousNovelty,
        identity: { entityType: input.entityType, entityKey: input.entityKey },
        sourceDefinitionId: prior.first_source_definition_id,
        canonicalRecordId: input.canonicalRecordId,
        reason: "ENTITY_FIRST_SOURCE_CHANGED",
      });
    }
  }

  const inserted = await input.client.query<{ id: string }>(
    `INSERT INTO entity_history_revisions(
       entity_key,entity_type,revision_number,
       first_seen_time,first_seen_date,last_seen_time,last_seen_date,
       first_source_definition_id,last_source_definition_id,
       observation_count,source_count,revision_acquisition_basis,
       input_fingerprint,supersedes_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
     ) RETURNING id`,
    [
      input.entityKey,
      input.entityType,
      (prior?.revision_number ?? 0) + 1,
      first.observed_time,
      first.observed_date,
      last.observed_time,
      last.observed_date,
      first.source_definition_id,
      last.source_definition_id,
      rows.length,
      sourceCount,
      input.acquisitionBasis,
      fingerprint,
      prior?.current_revision_id ?? null,
    ],
  );
  const historyId = inserted.rows[0]?.id;
  if (!historyId) throw new Error("Failed to append entity history revision");

  await input.client.query(
    `INSERT INTO entity_history_heads(
       entity_key,entity_type,current_revision_id,
       first_seen_time,first_seen_date,last_seen_time,last_seen_date,
       first_source_definition_id,last_source_definition_id,
       observation_count,source_count,revision_acquisition_basis,updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
     ON CONFLICT (entity_type,entity_key)
     DO UPDATE SET
       current_revision_id=EXCLUDED.current_revision_id,
       first_seen_time=EXCLUDED.first_seen_time,
       first_seen_date=EXCLUDED.first_seen_date,
       last_seen_time=EXCLUDED.last_seen_time,
       last_seen_date=EXCLUDED.last_seen_date,
       first_source_definition_id=EXCLUDED.first_source_definition_id,
       last_source_definition_id=EXCLUDED.last_source_definition_id,
       observation_count=EXCLUDED.observation_count,
       source_count=EXCLUDED.source_count,
       revision_acquisition_basis=EXCLUDED.revision_acquisition_basis,
       updated_at=now()`,
    [
      input.entityKey,
      input.entityType,
      historyId,
      first.observed_time,
      first.observed_date,
      last.observed_time,
      last.observed_date,
      first.source_definition_id,
      last.source_definition_id,
      rows.length,
      sourceCount,
      input.acquisitionBasis,
    ],
  );

  return {
    entityKey: input.entityKey,
    entityType: input.entityType,
    firstSeenTime: first.observed_time?.toISOString() ?? null,
    firstSeenDate: first.observed_date,
    firstSourceDefinitionId: first.source_definition_id,
    firstSourceKey: first.source_key,
    historyFingerprint: fingerprint,
    acquisitionBasis: input.acquisitionBasis,
  };
}

async function retractMissingObservations(input: {
  client: PoolClient;
  canonical: CanonicalProjectionInput;
  currentObservationKeys: ReadonlySet<string>;
  currentBasis: AcquisitionBasis;
}): Promise<Map<string, { entityType: string; entityKey: string }>> {
  const existing = await input.client.query<{
    observation_key: string;
    current_revision_id: string;
    revision_number: number;
    entity_key: string;
    entity_type: string;
    entity_role: string;
    observed_time: Date | null;
    observed_date: string | null;
    time_precision: "INSTANT" | "DATE";
    observation_basis: string;
    input_fingerprint: string;
  }>(
    `SELECT head.observation_key,head.current_revision_id,
            revision.revision_number,head.entity_key,head.entity_type,
            head.entity_role,head.observed_time,head.observed_date::text,
            revision.time_precision,revision.observation_basis,
            revision.input_fingerprint
     FROM entity_observation_heads head
     JOIN entity_observation_revisions revision ON revision.id=head.current_revision_id
     WHERE head.source_definition_id=$1
       AND head.state='ACTIVE'
       AND revision.source_record_id=$2
     FOR UPDATE OF head`,
    [input.canonical.sourceDefinitionId, input.canonical.sourceRecordId],
  );

  const changed = new Map<string, { entityType: string; entityKey: string }>();
  for (const row of existing.rows) {
    if (input.currentObservationKeys.has(row.observation_key)) continue;

    const retractionFingerprint = sha256({
      previous: row.input_fingerprint,
      retractedByCanonical: input.canonical.id,
    });
    const inserted = await input.client.query<{ id: string }>(
      `INSERT INTO entity_observation_revisions(
         observation_key,revision_number,state,entity_key,entity_type,entity_role,
         source_definition_id,source_record_id,canonical_record_id,raw_record_id,
         observed_time,observed_date,time_precision,observation_basis,
         acquisition_basis,input_fingerprint,supersedes_id
       ) VALUES (
         $1,$2,'RETRACTED',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       ) RETURNING id`,
      [
        row.observation_key,
        row.revision_number + 1,
        row.entity_key,
        row.entity_type,
        row.entity_role,
        input.canonical.sourceDefinitionId,
        input.canonical.sourceRecordId,
        input.canonical.id,
        input.canonical.rawRecordId,
        row.observed_time,
        row.observed_date,
        row.time_precision,
        row.observation_basis,
        input.currentBasis,
        retractionFingerprint,
        row.current_revision_id,
      ],
    );
    const revisionId = inserted.rows[0]?.id;
    if (!revisionId) throw new Error("Failed to append entity observation retraction");

    await input.client.query(
      `UPDATE entity_observation_heads
       SET current_revision_id=$2,state='RETRACTED',updated_at=now()
       WHERE observation_key=$1`,
      [row.observation_key, revisionId],
    );
    changed.set(`${row.entity_type}\u0000${row.entity_key}`, {
      entityType: row.entity_type,
      entityKey: row.entity_key,
    });
  }
  return changed;
}

export async function processEntityObservations(input: {
  client: PoolClient;
  canonical: CanonicalProjectionInput;
}): Promise<ChangedEntityHistory[]> {
  const projector = measurementSourceProjectors.get(input.canonical.sourceKey);
  if (!projector) return [];

  const observations = projector.projectEntityObservations(input.canonical);
  const currentBasis = acquisitionBasis(input.canonical.trigger, input.canonical.purpose);
  const source = await input.client.query<{ observation_basis: string }>(
    `SELECT observation_basis FROM source_definitions WHERE id=$1`,
    [input.canonical.sourceDefinitionId],
  );
  const observationBasis = source.rows[0]?.observation_basis ?? "UNKNOWN";

  const changedEntities = await retractMissingObservations({
    client: input.client,
    canonical: input.canonical,
    currentObservationKeys: new Set(observations.map((observation) => observation.observationKey)),
    currentBasis,
  });

  for (const observation of observations) {
    const current = await input.client.query<{
      current_revision_id: string;
      revision_number: number;
      input_fingerprint: string;
      state: string;
    }>(
      `SELECT head.current_revision_id,revision.revision_number,
              revision.input_fingerprint,head.state
       FROM entity_observation_heads head
       JOIN entity_observation_revisions revision ON revision.id=head.current_revision_id
       WHERE head.observation_key=$1
       FOR UPDATE OF head`,
      [observation.observationKey],
    );
    const prior = current.rows[0];
    if (prior?.input_fingerprint === observation.inputFingerprint && prior.state === "ACTIVE") {
      continue;
    }

    const inserted = await input.client.query<{ id: string }>(
      `INSERT INTO entity_observation_revisions(
         observation_key,revision_number,state,entity_key,entity_type,entity_role,
         source_definition_id,source_record_id,canonical_record_id,raw_record_id,
         observed_time,observed_date,time_precision,observation_basis,
         acquisition_basis,input_fingerprint,supersedes_id
       ) VALUES (
         $1,$2,'ACTIVE',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       ) RETURNING id`,
      [
        observation.observationKey,
        (prior?.revision_number ?? 0) + 1,
        observation.entityKey,
        observation.entityType,
        observation.entityRole,
        input.canonical.sourceDefinitionId,
        input.canonical.sourceRecordId,
        input.canonical.id,
        input.canonical.rawRecordId,
        observation.observedTime,
        observation.observedDate,
        observation.timePrecision,
        observationBasis,
        currentBasis,
        observation.inputFingerprint,
        prior?.current_revision_id ?? null,
      ],
    );
    const revisionId = inserted.rows[0]?.id;
    if (!revisionId) throw new Error("Failed to append entity observation revision");

    await input.client.query(
      `INSERT INTO entity_observation_heads(
         observation_key,current_revision_id,state,entity_key,entity_type,entity_role,
         source_definition_id,observed_time,observed_date,acquisition_basis,updated_at
       ) VALUES ($1,$2,'ACTIVE',$3,$4,$5,$6,$7,$8,$9,now())
       ON CONFLICT (observation_key)
       DO UPDATE SET
         current_revision_id=EXCLUDED.current_revision_id,
         state='ACTIVE',
         entity_key=EXCLUDED.entity_key,
         entity_type=EXCLUDED.entity_type,
         entity_role=EXCLUDED.entity_role,
         source_definition_id=EXCLUDED.source_definition_id,
         observed_time=EXCLUDED.observed_time,
         observed_date=EXCLUDED.observed_date,
         acquisition_basis=EXCLUDED.acquisition_basis,
         updated_at=now()`,
      [
        observation.observationKey,
        revisionId,
        observation.entityKey,
        observation.entityType,
        observation.entityRole,
        input.canonical.sourceDefinitionId,
        observation.observedTime,
        observation.observedDate,
        currentBasis,
      ],
    );

    changedEntities.set(`${observation.entityType}\u0000${observation.entityKey}`, {
      entityType: observation.entityType,
      entityKey: observation.entityKey,
    });
  }

  const output: ChangedEntityHistory[] = [];
  for (const entity of changedEntities.values()) {
    const changed = await recomputeEntityHistory({
      client: input.client,
      ...entity,
      acquisitionBasis: currentBasis,
      canonicalRecordId: input.canonical.id,
    });
    if (changed) output.push(changed);
  }
  return output;
}
