import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface ResolveSecretOptions {
  fileEnvName?: string;
  maxBytes?: number;
  required?: boolean;
}

function normalizeDirect(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function normalizeFileValue(value: string): string | undefined {
  const normalized = value.replace(/[\r\n]+$/u, "");
  return normalized.length === 0 ? undefined : normalized;
}

export function resolveSecret(
  env: NodeJS.ProcessEnv,
  envName: string,
  options: ResolveSecretOptions = {},
): string | undefined {
  const fileEnvName = options.fileEnvName ?? `${envName}_FILE`;
  const maxBytes = options.maxBytes ?? 8 * 1024;
  const direct = normalizeDirect(env[envName]);
  const filePath = normalizeDirect(env[fileEnvName]);

  if (direct !== undefined && filePath !== undefined) {
    throw new Error(`${envName} and ${fileEnvName} are mutually exclusive`);
  }

  let resolved = direct;
  if (filePath !== undefined) {
    if (!path.isAbsolute(filePath)) throw new Error(`${fileEnvName} must be an absolute path`);
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error(`${fileEnvName} must reference a regular file`);
    if (stat.size > maxBytes) throw new Error(`${fileEnvName} exceeds ${maxBytes} bytes`);
    resolved = normalizeFileValue(readFileSync(filePath, "utf8"));
  }

  if (options.required && resolved === undefined) throw new Error(`${envName} is required`);
  return resolved;
}

export function secretEnvWithResolvedValues(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): NodeJS.ProcessEnv {
  const resolved = { ...env };
  for (const name of names) {
    const value = resolveSecret(env, name);
    if (value === undefined) delete resolved[name];
    else resolved[name] = value;
  }
  return resolved;
}
