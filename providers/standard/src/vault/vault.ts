import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  CredentialExpiredError,
  CredentialReleasedError,
  CredentialScopeError,
  VaultContractError,
  defineCredentialScope,
  type CredentialRequest,
  type CredentialResponse,
  type CredentialScope,
  type ShortLivedCredential,
  type VaultPort,
} from '@openagentcore/kernel';

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_REFRESH_FRACTION = 0.8;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SALT_BYTES = 16;

export interface VaultClockOptions {
  readonly ttlMs?: number;
  readonly refreshFraction?: number;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface EnvironmentVaultOptions extends VaultClockOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly variables?: Readonly<Record<string, string>>;
}

export interface EncryptedFileVaultOptions extends VaultClockOptions {
  readonly filename: string;
  readonly passphrase: string;
}

export interface KmsIssuedCredential {
  readonly value: string;
  readonly expiresAt: string;
  readonly refreshAfter?: string;
}

/** Cloud-specific KMS adapters implement only this issuer and stay outside Kernel APIs. */
export interface KmsCredentialIssuer {
  issue(scope: CredentialScope): Promise<KmsIssuedCredential>;
  close?(): Promise<void>;
}

export interface KmsVaultOptions {
  readonly issuer: KmsCredentialIssuer;
  readonly now?: () => number;
  readonly fetch?: typeof globalThis.fetch;
}

export interface WriteEncryptedVaultFileOptions {
  readonly filename: string;
  readonly passphrase: string;
  readonly credentials: Readonly<Record<string, string>>;
}

export class VaultCredentialNotFoundError extends Error {
  constructor(scope: CredentialScope, source: string) {
    super(`Credential scope ${scope.id} is not configured in ${source}.`);
    this.name = 'VaultCredentialNotFoundError';
  }
}

export class EncryptedVaultFileError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EncryptedVaultFileError';
  }
}

interface ResolvedCredentialMaterial {
  readonly value: string;
  readonly expiresAt: number;
  readonly refreshAfter: number;
}

abstract class RequestProxyVault implements VaultPort {
  readonly #now: () => number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: Pick<VaultClockOptions, 'now' | 'fetch'>) {
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== 'function') {
      throw new VaultContractError('Vault requires fetch in runtimes without global fetch.');
    }
  }

  async issue(scope: CredentialScope): Promise<ShortLivedCredential> {
    const safeScope = defineCredentialScope(scope.id, {
      targets: scope.targets,
      header: scope.header,
      prefix: scope.prefix,
    });
    const material = await this.resolve(safeScope, this.#now());
    validateMaterial(material, this.#now());
    return credentialProxy(safeScope, material, this.#now, this.#fetch, () =>
      this.issue(safeScope),
    );
  }

  protected abstract resolve(
    scope: CredentialScope,
    now: number,
  ): Promise<ResolvedCredentialMaterial>;
}

/** Zero-file adapter. Scope IDs map to OAC_VAULT_* variables unless explicitly overridden. */
export class EnvironmentVault extends RequestProxyVault {
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #variables: Readonly<Record<string, string>>;
  readonly #ttlMs: number;
  readonly #refreshFraction: number;

  constructor(options: EnvironmentVaultOptions = {}) {
    super(options);
    this.#environment = options.environment ?? runtimeEnvironment();
    this.#variables = Object.freeze({ ...(options.variables ?? {}) });
    this.#ttlMs = positiveDuration(options.ttlMs ?? DEFAULT_TTL_MS, 'ttlMs');
    this.#refreshFraction = refreshFraction(options.refreshFraction);
  }

  protected async resolve(
    scope: CredentialScope,
    now: number,
  ): Promise<ResolvedCredentialMaterial> {
    const variable = this.#variables[scope.id] ?? environmentVariableForScope(scope.id);
    const value = this.#environment[variable];
    if (value === undefined || value.length === 0) {
      throw new VaultCredentialNotFoundError(scope, variable);
    }
    return fixedLifetime(value, now, this.#ttlMs, this.#refreshFraction);
  }
}

/** AES-256-GCM encrypted JSON file adapter. The plaintext never leaves this module. */
export class EncryptedFileVault extends RequestProxyVault {
  readonly #filename: string;
  readonly #passphrase: string;
  readonly #ttlMs: number;
  readonly #refreshFraction: number;

  constructor(options: EncryptedFileVaultOptions) {
    super(options);
    if (options.filename.length === 0 || options.passphrase.length === 0) {
      throw new VaultContractError('Encrypted vault filename and passphrase must be non-empty.');
    }
    this.#filename = options.filename;
    this.#passphrase = options.passphrase;
    this.#ttlMs = positiveDuration(options.ttlMs ?? DEFAULT_TTL_MS, 'ttlMs');
    this.#refreshFraction = refreshFraction(options.refreshFraction);
  }

  protected async resolve(
    scope: CredentialScope,
    now: number,
  ): Promise<ResolvedCredentialMaterial> {
    const credentials = await readEncryptedCredentials(this.#filename, this.#passphrase);
    const value = credentials[scope.id];
    if (value === undefined || value.length === 0) {
      throw new VaultCredentialNotFoundError(scope, 'encrypted vault file');
    }
    return fixedLifetime(value, now, this.#ttlMs, this.#refreshFraction);
  }
}

/** Generic KMS bridge. A cloud provider owns the issuer and returns an actual short-lived value. */
export class KmsVault extends RequestProxyVault {
  readonly #issuer: KmsCredentialIssuer;

  constructor(options: KmsVaultOptions) {
    super(options);
    this.#issuer = options.issuer;
  }

  protected async resolve(scope: CredentialScope): Promise<ResolvedCredentialMaterial> {
    const issued = await this.#issuer.issue(scope);
    const expiresAt = parseTimestamp(issued.expiresAt, 'KMS credential expiresAt');
    const refreshAfter =
      issued.refreshAfter === undefined
        ? expiresAt
        : parseTimestamp(issued.refreshAfter, 'KMS credential refreshAfter');
    return { value: issued.value, expiresAt, refreshAfter };
  }

  async close(): Promise<void> {
    await this.#issuer.close?.();
  }
}

export function environmentVariableForScope(scopeId: string): string {
  const normalized = scopeId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  if (normalized.length === 0) {
    throw new VaultContractError('Credential scope cannot map to an empty environment name.');
  }
  return `OAC_VAULT_${normalized}`;
}

export async function writeEncryptedVaultFile(
  options: WriteEncryptedVaultFileOptions,
): Promise<void> {
  if (options.filename.length === 0 || options.passphrase.length === 0) {
    throw new VaultContractError('Encrypted vault filename and passphrase must be non-empty.');
  }
  const credentials = validateCredentialRecord(options.credentials);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = scryptSync(options.passphrase, salt, KEY_BYTES);
  let ciphertext: Buffer;
  let tag: Buffer;
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ version: 1, credentials }), 'utf8'),
      cipher.final(),
    ]);
    tag = cipher.getAuthTag();
  } finally {
    key.fill(0);
  }
  const envelope = `${JSON.stringify({
    version: 1,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  })}\n`;
  const temporary = join(dirname(options.filename), `.oac-vault-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, envelope, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, options.filename);
    await chmod(options.filename, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

function credentialProxy(
  scope: CredentialScope,
  material: ResolvedCredentialMaterial,
  now: () => number,
  fetch: typeof globalThis.fetch,
  reissue: () => Promise<ShortLivedCredential>,
): ShortLivedCredential {
  let released = false;
  const request = async (
    input: CredentialRequest,
    signal: AbortSignal,
  ): Promise<CredentialResponse> => {
    signal.throwIfAborted();
    assertUsable(scope, released, material.expiresAt, now());
    const method = (input.method ?? 'GET').toUpperCase();
    const target = authorizedTarget(scope, input.url, method);
    if (!target) throw new CredentialScopeError(scope);
    const headers = new Headers(input.headers);
    if (headers.has(scope.header)) {
      throw new VaultContractError(
        `Credential request must not supply the managed ${scope.header} header.`,
      );
    }
    headers.set(scope.header, `${scope.prefix}${material.value}`);
    const response = await fetch(input.url, {
      method,
      headers,
      redirect: 'error',
      signal,
      ...(input.body === undefined ? {} : { body: credentialRequestBody(input.body) }),
    });
    signal.throwIfAborted();
    return Object.freeze({
      status: response.status,
      headers: Object.freeze(Object.fromEntries(response.headers.entries())),
      body: new Uint8Array(await response.arrayBuffer()),
    });
  };
  const refresh = async (signal: AbortSignal): Promise<ShortLivedCredential> => {
    signal.throwIfAborted();
    assertUsable(scope, released, material.expiresAt, now(), true);
    released = true;
    const replacement = await reissue();
    signal.throwIfAborted();
    return replacement;
  };
  return Object.freeze({
    scope,
    expiresAt: new Date(material.expiresAt).toISOString(),
    refreshAfter: new Date(material.refreshAfter).toISOString(),
    request,
    refresh,
    release: () => {
      released = true;
    },
  });
}

function authorizedTarget(scope: CredentialScope, value: string, method: string): boolean {
  let request: URL;
  try {
    request = new URL(value);
  } catch {
    return false;
  }
  if (request.username.length > 0 || request.password.length > 0) return false;
  return scope.targets.some((target) => {
    const base = new URL(target.urlPrefix);
    if (base.origin !== request.origin) return false;
    const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
    const pathAllowed = request.pathname === base.pathname || request.pathname.startsWith(prefix);
    return pathAllowed && (target.methods === undefined || target.methods.includes(method));
  });
}

function credentialRequestBody(value: string | Uint8Array): string | ArrayBuffer {
  if (typeof value === 'string') return value;
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function assertUsable(
  scope: CredentialScope,
  released: boolean,
  expiresAt: number,
  now: number,
  allowExpired = false,
): void {
  if (released) throw new CredentialReleasedError(scope);
  if (!allowExpired && now >= expiresAt) throw new CredentialExpiredError(scope);
}

function fixedLifetime(
  value: string,
  now: number,
  ttlMs: number,
  refresh: number,
): ResolvedCredentialMaterial {
  return {
    value,
    expiresAt: now + ttlMs,
    refreshAfter: now + Math.floor(ttlMs * refresh),
  };
}

function validateMaterial(material: ResolvedCredentialMaterial, now: number): void {
  if (material.value.length === 0) {
    throw new VaultContractError('Credential issuer returned an empty value.');
  }
  if (
    !Number.isSafeInteger(material.expiresAt) ||
    !Number.isSafeInteger(material.refreshAfter) ||
    material.expiresAt <= now ||
    material.refreshAfter > material.expiresAt
  ) {
    throw new VaultContractError('Credential issuer returned invalid expiry or refresh metadata.');
  }
}

function positiveDuration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new VaultContractError(`${field} must be a positive safe integer.`);
  }
  return value;
}

function refreshFraction(value = DEFAULT_REFRESH_FRACTION): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new VaultContractError('refreshFraction must be greater than zero and at most one.');
  }
  return value;
}

async function readEncryptedCredentials(
  filename: string,
  passphrase: string,
): Promise<Readonly<Record<string, string>>> {
  const file = await stat(filename);
  if ((file.mode & 0o077) !== 0) {
    throw new EncryptedVaultFileError('Encrypted vault file permissions must be 0600 or stricter.');
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(await readFile(filename, 'utf8')) as unknown;
  } catch (error) {
    throw new EncryptedVaultFileError('Encrypted vault file is not valid JSON.', { cause: error });
  }
  if (!isEnvelope(envelope)) {
    throw new EncryptedVaultFileError('Encrypted vault file envelope is invalid.');
  }
  const salt = decodeBase64(envelope.salt);
  const iv = decodeBase64(envelope.iv);
  const tag = decodeBase64(envelope.tag);
  const ciphertext = decodeBase64(envelope.ciphertext);
  const key = scryptSync(passphrase, salt, KEY_BYTES);
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    throw new EncryptedVaultFileError('Encrypted vault authentication failed.', { cause: error });
  } finally {
    key.fill(0);
  }
  try {
    const payload = JSON.parse(plaintext.toString('utf8')) as unknown;
    if (!isCredentialPayload(payload)) {
      throw new EncryptedVaultFileError('Encrypted vault plaintext schema is invalid.');
    }
    return validateCredentialRecord(payload.credentials);
  } catch (error) {
    if (error instanceof EncryptedVaultFileError) throw error;
    throw new EncryptedVaultFileError('Encrypted vault plaintext is invalid.', { cause: error });
  } finally {
    plaintext.fill(0);
  }
}

interface EncryptedEnvelope {
  readonly version: 1;
  readonly algorithm: 'aes-256-gcm';
  readonly kdf: 'scrypt';
  readonly salt: string;
  readonly iv: string;
  readonly tag: string;
  readonly ciphertext: string;
}

function isEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!isRecord(value)) return false;
  return (
    value['version'] === 1 &&
    value['algorithm'] === 'aes-256-gcm' &&
    value['kdf'] === 'scrypt' &&
    ['salt', 'iv', 'tag', 'ciphertext'].every((key) => typeof value[key] === 'string')
  );
}

function isCredentialPayload(
  value: unknown,
): value is { readonly version: 1; readonly credentials: Readonly<Record<string, string>> } {
  return isRecord(value) && value['version'] === 1 && isRecord(value['credentials']);
}

function validateCredentialRecord(
  value: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const [scope, credential] of Object.entries(value)) {
    defineCredentialScope(scope);
    if (typeof credential !== 'string' || credential.length === 0) {
      throw new VaultContractError('Encrypted vault credentials must be non-empty strings.');
    }
    credentials[scope] = credential;
  }
  return credentials;
}

function decodeBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new EncryptedVaultFileError('Encrypted vault contains invalid base64 data.');
  }
  return decoded;
}

function parseTimestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new VaultContractError(`${field} must be a valid timestamp.`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function runtimeEnvironment(): Readonly<Record<string, string | undefined>> {
  const processValue = (globalThis as { readonly process?: unknown }).process;
  if (!isRecord(processValue) || !isRecord(processValue['env'])) return {};
  return processValue['env'] as Readonly<Record<string, string | undefined>>;
}
