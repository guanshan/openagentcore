import type { JsonObject, JsonValue, ToolExecutionResult } from '@openagentcore/kernel';

export class CodingToolInputError extends Error {
  constructor(tool: string, detail: string) {
    super(`${tool}: ${detail}`);
    this.name = 'CodingToolInputError';
  }
}

export function inputObject(tool: string, value: JsonValue): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CodingToolInputError(tool, 'arguments must be an object.');
  }
  return value as JsonObject;
}

export function stringInput(
  tool: string,
  object: JsonObject,
  field: string,
  options: { readonly allowEmpty?: boolean } = {},
): string {
  const value = object[field];
  if (typeof value !== 'string' || (options.allowEmpty !== true && value.length === 0)) {
    throw new CodingToolInputError(tool, `${field} must be a non-empty string.`);
  }
  return value;
}

export function optionalStringInput(
  tool: string,
  object: JsonObject,
  field: string,
): string | undefined {
  const value = object[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new CodingToolInputError(tool, `${field} must be a string when provided.`);
  }
  return value;
}

export function stringArrayInput(
  tool: string,
  object: JsonObject,
  field: string,
): readonly string[] {
  const value = object[field];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new CodingToolInputError(tool, `${field} must be a non-empty string array.`);
  }
  return value;
}

export function succeeded(result: JsonValue): ToolExecutionResult {
  return { outcome: 'succeeded', result };
}

export function failed(result: JsonValue): ToolExecutionResult {
  return { outcome: 'failed', result };
}
