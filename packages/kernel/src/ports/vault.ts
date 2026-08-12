export interface CredentialScope {
  /** Stable, audit-safe identifier. Secret material must never be embedded in this value. */
  readonly id: string;
  /** Authenticated HTTP targets authorized by this scope. */
  readonly targets: readonly CredentialTarget[];
  /** Header injection is performed inside the proxy and is never visible to the tool. */
  readonly header: string;
  readonly prefix: string;
}

export interface CredentialTarget {
  readonly urlPrefix: string;
  readonly methods?: readonly string[];
}

export interface CredentialScopeOptions {
  readonly targets?: readonly CredentialTarget[];
  readonly header?: string;
  readonly prefix?: string;
}

export interface CredentialRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export interface CredentialResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/**
 * A scoped capability object. It can perform an authenticated request but never reveals the
 * backing credential material to its consumer.
 */
export interface ShortLivedCredential {
  readonly scope: CredentialScope;
  readonly expiresAt: string;
  readonly refreshAfter: string;
  request(request: CredentialRequest, signal: AbortSignal): Promise<CredentialResponse>;
  refresh(signal: AbortSignal): Promise<ShortLivedCredential>;
  release(): void;
}

export interface VaultPort {
  issue(scope: CredentialScope): Promise<ShortLivedCredential>;
  close?(): Promise<void>;
}

export class VaultContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultContractError';
  }
}

export class VaultUnavailableError extends Error {
  constructor(scope: CredentialScope) {
    super(`No VaultPort is configured for credential scope ${scope.id}.`);
    this.name = 'VaultUnavailableError';
  }
}

export class CredentialScopeError extends Error {
  constructor(scope: CredentialScope) {
    super(`Credential scope ${scope.id} does not authorize the requested operation.`);
    this.name = 'CredentialScopeError';
  }
}

export class CredentialExpiredError extends Error {
  constructor(scope: CredentialScope) {
    super(`Credential scope ${scope.id} has expired and must be refreshed.`);
    this.name = 'CredentialExpiredError';
  }
}

export class CredentialReleasedError extends Error {
  constructor(scope: CredentialScope) {
    super(`Credential scope ${scope.id} has already been released.`);
    this.name = 'CredentialReleasedError';
  }
}

export function defineCredentialScope(
  id: string,
  options: CredentialScopeOptions = {},
): CredentialScope {
  if (typeof id !== 'string' || id.trim().length === 0 || id !== id.trim()) {
    throw new VaultContractError('Credential scope id must be a non-empty trimmed string.');
  }
  if (/[\r\n\0]/u.test(id)) {
    throw new VaultContractError('Credential scope id contains a forbidden control character.');
  }
  const header = options.header ?? 'authorization';
  const prefix = options.prefix ?? 'Bearer ';
  try {
    new Headers([[header, `${prefix}value`]]);
  } catch {
    throw new VaultContractError('Credential scope header or prefix is invalid.');
  }
  const targets = (options.targets ?? []).map((target) => {
    let parsed: URL;
    try {
      parsed = new URL(target.urlPrefix);
    } catch {
      throw new VaultContractError('Credential target must be an absolute HTTP(S) URL.');
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new VaultContractError(
        'Credential target must be an absolute HTTP(S) URL without credentials, query, or fragment.',
      );
    }
    const methods = target.methods?.map((method) => {
      const normalized = method.toUpperCase();
      if (!/^[A-Z]+$/u.test(normalized)) {
        throw new VaultContractError('Credential target method must contain only letters.');
      }
      return normalized;
    });
    return Object.freeze({
      urlPrefix: parsed.toString(),
      ...(methods === undefined ? {} : { methods: Object.freeze([...new Set(methods)]) }),
    });
  });
  return Object.freeze({
    id,
    targets: Object.freeze(targets),
    header,
    prefix,
  });
}

/** Null Object that fails closed only when a credential-bound tool actually executes. */
export class UnavailableVault implements VaultPort {
  async issue(scope: CredentialScope): Promise<never> {
    throw new VaultUnavailableError(scope);
  }
}
