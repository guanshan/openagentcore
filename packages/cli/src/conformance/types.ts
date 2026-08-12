import type {
  ModelPort,
  ModelRequest,
  SandboxExecRequest,
  SandboxPort,
  StorePort,
  StoreCapabilities,
  TracePort,
  VaultPort,
  CredentialRequest,
  CredentialScope,
} from '@openagentcore/kernel';

export type ConformancePort = 'model' | 'sandbox' | 'store' | 'trace' | 'vault';
export type ConformanceStatus = 'passed' | 'failed' | 'skipped';

export interface ConformanceCaseResult {
  readonly name: string;
  readonly status: Exclude<ConformanceStatus, 'skipped'>;
  readonly detail: string;
}

export interface ConformanceSuiteResult {
  readonly port: ConformancePort;
  readonly adapter: string;
  readonly status: ConformanceStatus;
  readonly capabilities: Readonly<Record<string, boolean | number | string>>;
  readonly detail: string;
  readonly cases: readonly ConformanceCaseResult[];
}

export interface ConformanceReport {
  readonly schemaVersion: '1.0.0';
  readonly status: 'passed' | 'failed';
  readonly suites: readonly ConformanceSuiteResult[];
}

export interface ModelConformanceAdapter {
  readonly name: string;
  readonly capabilities?: Readonly<Record<string, boolean | number | string>>;
  create(): ModelPort;
  readonly request?: ModelRequest;
  availability?(): Promise<{ readonly available: boolean; readonly reason: string }>;
}

export interface SandboxConformanceAdapter {
  readonly name: string;
  create(root: string): SandboxPort;
  readonly execProbe?: SandboxExecRequest;
  availability?(
    sandbox: SandboxPort,
    signal: AbortSignal,
  ): Promise<{ readonly available: boolean; readonly reason: string }>;
}

export interface StoreConformanceAdapter {
  readonly name: string;
  readonly capabilities?: StoreCapabilities;
  create(): Promise<StorePort>;
  availability?(): Promise<{ readonly available: boolean; readonly reason: string }>;
  dispose?(): Promise<void>;
}

export interface TraceConformanceAdapter {
  readonly name: string;
  readonly capabilities?: Readonly<Record<string, boolean | number | string>>;
  create(): TracePort;
  availability?(): Promise<{ readonly available: boolean; readonly reason: string }>;
}

export interface VaultConformanceInstance {
  readonly vault: VaultPort;
  readonly primaryScope: CredentialScope;
  readonly otherScope: CredentialScope;
  readonly primaryRequest: CredentialRequest;
  readonly otherRequest: CredentialRequest;
  advanceClock(ms: number): void;
  authenticated(): boolean;
}

export interface VaultConformanceAdapter {
  readonly name: string;
  create(material: string): Promise<VaultConformanceInstance>;
  dispose?(): Promise<void>;
}
