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
