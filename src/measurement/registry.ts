import { createHash } from "node:crypto";
import { withTransaction } from "../db/pool.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";
import {
  measurementRegistrationSchema,
  type MeasurementDefinition,
  type MeasurementRegistration,
} from "./contracts.js";
import { measurementRegistrations } from "./definitions.js";

export interface RegisteredMeasurement extends MeasurementRegistration {
  definitionHash: string;
  calculationHash: string;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}

function validateRegistration(input: MeasurementRegistration): RegisteredMeasurement {
  const parsed = measurementRegistrationSchema.parse(input);
  return {
    ...parsed,
    definitionHash: sha256(parsed.definition),
    calculationHash: sha256(parsed.calculation),
  };
}

export const measurementRegistry: readonly RegisteredMeasurement[] = Object.freeze(
  measurementRegistrations.map((registration) => Object.freeze(validateRegistration(registration))),
);

const registryByKey = new Map<string, RegisteredMeasurement>();
for (const registration of measurementRegistry) {
  const existing = registryByKey.get(registration.definition.measurementKey);
  if (existing) throw new Error(`Duplicate measurement registration: ${registration.definition.measurementKey}`);
  registryByKey.set(registration.definition.measurementKey, registration);
}

export function getMeasurementRegistration(measurementKey: string): RegisteredMeasurement | null {
  return registryByKey.get(measurementKey) ?? null;
}

export function publicMeasurementRegistry(): readonly RegisteredMeasurement[] {
  return measurementRegistry.filter((registration) => registration.definition.visibility === "PUBLIC");
}

function json(value: unknown): string {
  return canonicalJsonStringify(value);
}

export async function syncMeasurementRegistry(): Promise<void> {
  await withTransaction(async (client) => {
    for (const registration of measurementRegistry) {
      const definition: MeasurementDefinition = registration.definition;
      const existingDefinition = await client.query<{ id: string; contract_sha256: string }>(
        `SELECT id, contract_sha256
         FROM measurement_definitions
         WHERE measurement_key = $1 AND contract_version = $2`,
        [definition.measurementKey, definition.contractVersion],
      );

      let definitionId: string;
      const currentDefinition = existingDefinition.rows[0];
      if (currentDefinition) {
        if (currentDefinition.contract_sha256 !== registration.definitionHash) {
          throw new Error(`Measurement contract mismatch for ${definition.measurementKey}/${definition.contractVersion}`);
        }
        definitionId = currentDefinition.id;
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO measurement_definitions(
             measurement_key, contract_version, domain, display_label, description, unit,
             value_kind, primary_time_axis, time_precision, source_scope, record_kind_scope,
             supported_granularities, supported_dimensions, coverage_policy, zero_policy,
             acquisition_policy, comparison_policy, population_profile, change_feed_policy,
             visibility, represents, does_not_represent, contract_sha256
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,
             $16,$17::jsonb,$18::jsonb,$19,$20,$21,$22,$23
           ) RETURNING id`,
          [
            definition.measurementKey,
            definition.contractVersion,
            definition.domain,
            definition.displayLabel,
            definition.description,
            definition.unit,
            definition.valueKind,
            definition.primaryTimeAxis,
            definition.timePrecision,
            json(definition.sourceKeys),
            json(definition.recordKinds),
            json(definition.supportedGranularities),
            json(definition.supportedDimensions),
            definition.coveragePolicy,
            definition.zeroPolicy,
            definition.acquisitionPolicy,
            json(definition.comparisonPolicy),
            json(definition.populationProfile),
            definition.changeFeedPolicy,
            definition.visibility,
            definition.represents,
            definition.doesNotRepresent,
            registration.definitionHash,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error(`Failed to insert measurement definition ${definition.measurementKey}`);
        definitionId = row.id;
      }

      const existingCalculation = await client.query<{ id: string; calculation_sha256: string }>(
        `SELECT id, calculation_sha256
         FROM measurement_calculation_versions
         WHERE measurement_definition_id = $1 AND calculation_version = $2`,
        [definitionId, registration.calculation.calculationVersion],
      );

      let calculationId: string;
      const currentCalculation = existingCalculation.rows[0];
      if (currentCalculation) {
        if (currentCalculation.calculation_sha256 !== registration.calculationHash) {
          throw new Error(`Measurement calculation mismatch for ${definition.measurementKey}/${registration.calculation.calculationVersion}`);
        }
        calculationId = currentCalculation.id;
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO measurement_calculation_versions(
             measurement_definition_id, calculation_version, projector_key,
             aggregation_kind, calculation_metadata, calculation_sha256
           ) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
           RETURNING id`,
          [
            definitionId,
            registration.calculation.calculationVersion,
            registration.calculation.projectorKey,
            registration.calculation.aggregationKind,
            json(registration.calculation.metadata),
            registration.calculationHash,
          ],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error(`Failed to insert measurement calculation ${definition.measurementKey}`);
        calculationId = row.id;
      }

      await client.query(
        `INSERT INTO measurement_definition_heads(
           measurement_key, active_definition_id, active_calculation_id, updated_at
         ) VALUES ($1,$2,$3,now())
         ON CONFLICT (measurement_key) DO UPDATE SET
           active_definition_id = EXCLUDED.active_definition_id,
           active_calculation_id = EXCLUDED.active_calculation_id,
           updated_at = now()`,
        [definition.measurementKey, definitionId, calculationId],
      );
    }
  });
}
