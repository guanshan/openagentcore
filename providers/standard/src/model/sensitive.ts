export const MODEL_SENSITIVE_KEYS = [
  'access-token',
  'access_token',
  'accesstoken',
  'api-key',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-api-key',
  'x_api_key',
] as const;

export function authorizationCredential(value: string): string | undefined {
  const credential = /^\S+[ \t]+(.+)$/.exec(value)?.[1]?.trim();
  return credential === undefined || credential.length === 0 ? undefined : credential;
}

export function redactSensitiveText(
  text: string,
  secrets: ReadonlySet<string> = new Set(),
): string {
  let sanitized = text;
  const longestFirst = [...secrets].sort((left, right) => right.length - left.length);
  for (const secret of longestFirst) {
    sanitized = sanitized.split(secret).join(MODEL_SENSITIVE_REDACTION);
  }
  return sanitized
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, `$1${MODEL_SENSITIVE_REDACTION}`)
    .replace(
      /((?:api[-_ ]?key|access[-_ ]?token)\s*[:=]\s*)[^\s,;]+/giu,
      `$1${MODEL_SENSITIVE_REDACTION}`,
    );
}

/** Applies the Record & Replay sensitive-key and credential-text rules to opt-in trace content. */
export function redactSensitiveContent(
  value: JsonValue,
  additionalSensitiveKeys: readonly string[] = [],
): JsonValue {
  const sensitiveKeys = new Set(
    [...MODEL_SENSITIVE_KEYS, ...additionalSensitiveKeys].map((key) => key.toLowerCase()),
  );
  const secrets = new Set<string>();
  collectSecrets(value, sensitiveKeys, secrets);
  return redactValue(value, sensitiveKeys, secrets);
}

function collectSecrets(
  value: JsonValue,
  sensitiveKeys: ReadonlySet<string>,
  secrets: Set<string>,
): void {
  if (Array.isArray(value)) {
    for (const nested of value) collectSecrets(nested, sensitiveKeys, secrets);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (sensitiveKeys.has(key.toLowerCase())) {
      collectStringValues(nested, secrets);
      if (typeof nested === 'string' && key.toLowerCase().includes('authorization')) {
        const credential = authorizationCredential(nested);
        if (credential !== undefined) secrets.add(credential);
      }
    } else {
      collectSecrets(nested, sensitiveKeys, secrets);
    }
  }
}

function collectStringValues(value: JsonValue, secrets: Set<string>): void {
  if (typeof value === 'string' && value.length > 0) {
    secrets.add(value);
  } else if (Array.isArray(value)) {
    for (const nested of value) collectStringValues(nested, secrets);
  } else if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) collectStringValues(nested, secrets);
  }
}

function redactValue(
  value: JsonValue,
  sensitiveKeys: ReadonlySet<string>,
  secrets: ReadonlySet<string>,
): JsonValue {
  if (typeof value === 'string') return redactSensitiveText(value, secrets);
  if (Array.isArray(value))
    return value.map((nested) => redactValue(nested, sensitiveKeys, secrets));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      sensitiveKeys.has(key.toLowerCase())
        ? MODEL_SENSITIVE_REDACTION
        : redactValue(nested, sensitiveKeys, secrets),
    ]),
  );
}
import type { JsonValue } from '@openagentcore/kernel';

export const MODEL_SENSITIVE_REDACTION = '[REDACTED]' as const;
