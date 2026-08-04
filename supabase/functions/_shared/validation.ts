import { ApiError } from './errors.ts';

export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new ApiError(400, 'bad_request');
  }
  return value as JsonObject;
}

export function onlyKeys(value: JsonObject, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new ApiError(400, 'bad_request');
  }
}

export function normalizedString(
  value: unknown,
  options: { min?: number; max: number; trim?: boolean; nullable?: boolean },
): string | null {
  if (value === null && options.nullable) return null;
  if (typeof value !== 'string') throw new ApiError(400, 'bad_request');
  const normalized = (options.trim === false ? value : value.trim()).normalize('NFC');
  const length = Array.from(normalized).length;
  if (length < (options.min ?? 0) || length > options.max) {
    throw new ApiError(400, 'bad_request');
  }
  return normalized;
}

export function optionalString(
  object: JsonObject,
  key: string,
  options: { min?: number; max: number; trim?: boolean; nullable?: boolean },
): string | null | undefined {
  if (!(key in object)) return undefined;
  return normalizedString(object[key], options);
}

export function requiredString(
  object: JsonObject,
  key: string,
  options: { min?: number; max: number; trim?: boolean },
): string {
  return normalizedString(object[key], options) as string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ApiError(400, 'bad_request');
  }
  return value.toLowerCase();
}

export function requiredUuid(object: JsonObject, key: string): string {
  return uuid(object[key]);
}

export function optionalUuid(
  object: JsonObject,
  key: string,
  nullable = false,
): string | null | undefined {
  if (!(key in object)) return undefined;
  if (object[key] === null && nullable) return null;
  return uuid(object[key]);
}

export function uuidArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) throw new ApiError(400, 'bad_request');
  const values = value.map(uuid);
  if (new Set(values).size !== values.length) throw new ApiError(400, 'bad_request');
  return values;
}

export function optionalUuidArray(
  object: JsonObject,
  key: string,
  max: number,
): string[] | undefined {
  if (!(key in object)) return undefined;
  return uuidArray(object[key], max);
}

export function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ApiError(400, 'bad_request');
  return value;
}

export function optionalBool(object: JsonObject, key: string): boolean | undefined {
  return key in object ? bool(object[key]) : undefined;
}

export function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new ApiError(400, 'bad_request');
  }
  return value as number;
}

export function optionalInteger(
  object: JsonObject,
  key: string,
  min: number,
  max: number,
): number | undefined {
  return key in object ? integer(object[key], min, max) : undefined;
}

export function oneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    throw new ApiError(400, 'bad_request');
  }
  return value as Values[number];
}

export function optionalOneOf<const Values extends readonly string[]>(
  object: JsonObject,
  key: string,
  values: Values,
): Values[number] | undefined {
  return key in object ? oneOf(object[key], values) : undefined;
}

export function isoDate(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) {
    throw new ApiError(400, 'bad_request');
  }
  return new Date(value).toISOString();
}

export function optionalRecord(
  object: JsonObject,
  key: string,
  maxBytes: number,
): JsonObject | undefined {
  if (!(key in object)) return undefined;
  const value = asObject(object[key]);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) {
    throw new ApiError(400, 'bad_request');
  }
  return value;
}
