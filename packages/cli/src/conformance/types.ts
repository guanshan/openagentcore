import type {
  ModelPort,
  ModelRequest,
  SandboxExecRequest,
  SandboxPort,
  StorePort,
} from '@openagentcore/kernel';

export type ConformancePort = 'model' | 'sandbox' | 'store' | 'trace';
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
  create(): ModelPort;
  readonly request?: ModelRequest;
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
  create(): Promise<StorePort>;
  availability?(): Promise<{ readonly available: boolean; readonly reason: string }>;
  dispose?(): Promise<void>;
}
