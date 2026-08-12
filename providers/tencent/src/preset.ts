import type {
  AgentLoop,
  EventLog,
  ModelPort,
  SandboxPort,
  Tool,
  ToolRegistrationOptions,
  TracePort,
  VaultPort,
} from '@openagentcore/kernel';
import { AgentBuilder } from '@openagentcore/standard';
import { EnvironmentVault, type EnvironmentVaultOptions } from '@openagentcore/standard/vault';

import { TencentHunyuanModel, type TencentHunyuanModelOptions } from './model/hunyuan.js';
import {
  TencentAgentRuntimeSandbox,
  type TencentAgentRuntimeSandboxOptions,
} from './sandbox/agent-runtime.js';
import { createTencentApmTrace, type TencentApmTraceOptions } from './trace/apm.js';

export type TencentPreset = 'tencent-full';
export type TencentEnvironment = Readonly<Record<string, string | undefined>>;

export interface TencentPresetAdapters {
  readonly model?: ModelPort;
  readonly sandbox?: SandboxPort;
  readonly trace?: TracePort;
  readonly vault?: VaultPort;
  readonly eventLog?: EventLog;
}

export interface TencentFullPresetOptions {
  readonly environment?: TencentEnvironment;
  readonly model?: Omit<TencentHunyuanModelOptions, 'apiKey'>;
  readonly sandbox?: Omit<TencentAgentRuntimeSandboxOptions, 'apiKey' | 'domain' | 'template'>;
  readonly trace?: Omit<TencentApmTraceOptions, 'endpoint' | 'headers'>;
  readonly vault?: Omit<EnvironmentVaultOptions, 'environment'>;
  /** Explicit Port overrides support cross-family composition and offline tests. */
  readonly adapters?: TencentPresetAdapters;
}

export class TencentPresetConfigError extends Error {
  constructor(variable: string) {
    super(`Tencent preset requires environment variable ${variable}.`);
    this.name = 'TencentPresetConfigError';
  }
}

/** Provider composition root; every Port remains replaceable before build(). */
export class TencentAgentBuilder {
  readonly #builder: AgentBuilder;

  private constructor(builder: AgentBuilder) {
    this.#builder = builder;
  }

  static fromPreset(
    preset: TencentPreset,
    options: TencentFullPresetOptions = {},
  ): TencentAgentBuilder {
    if (preset !== 'tencent-full') {
      throw new Error(`Unsupported Tencent preset ${String(preset)}.`);
    }
    const environment = options.environment ?? runtimeEnvironment();
    const model =
      options.adapters?.model ??
      new TencentHunyuanModel({
        ...options.model,
        apiKey: requiredEnvironment(environment, 'TENCENT_TOKENHUB_API_KEY'),
      });
    const sandbox =
      options.adapters?.sandbox ??
      new TencentAgentRuntimeSandbox({
        ...options.sandbox,
        apiKey: requiredEnvironment(environment, 'E2B_API_KEY'),
        domain: requiredEnvironment(environment, 'E2B_DOMAIN'),
        template: requiredEnvironment(environment, 'AGS_TEMPLATE'),
      });
    const trace =
      options.adapters?.trace ??
      createTencentApmTrace({
        ...options.trace,
        endpoint: requiredEnvironment(environment, 'TENCENT_APM_ENDPOINT'),
        ...authorizationHeaders(environment['TENCENT_APM_TOKEN']),
      });
    const vault =
      options.adapters?.vault ?? new EnvironmentVault({ ...options.vault, environment });

    const builder = AgentBuilder.fromPreset('oss-local')
      .model(model)
      .sandbox(sandbox)
      .trace(trace)
      .vault(vault);
    if (options.adapters?.eventLog !== undefined) {
      builder.eventLog(options.adapters.eventLog);
    }
    return new TencentAgentBuilder(builder);
  }

  model(model: ModelPort): this {
    this.#builder.model(model);
    return this;
  }

  sandbox(sandbox: SandboxPort): this {
    this.#builder.sandbox(sandbox);
    return this;
  }

  trace(trace: TracePort): this {
    this.#builder.trace(trace);
    return this;
  }

  vault(vault: VaultPort): this {
    this.#builder.vault(vault);
    return this;
  }

  eventLog(eventLog: EventLog): this {
    this.#builder.eventLog(eventLog);
    return this;
  }

  tool(tool: Tool, options: ToolRegistrationOptions = {}): this {
    this.#builder.tool(tool, options);
    return this;
  }

  build(): AgentLoop {
    return this.#builder.build();
  }
}

function requiredEnvironment(environment: TencentEnvironment, variable: string): string {
  const value = environment[variable];
  if (value === undefined || value.length === 0) {
    throw new TencentPresetConfigError(variable);
  }
  return value;
}

function authorizationHeaders(token: string | undefined): {
  readonly headers?: Readonly<Record<string, string>>;
} {
  return token === undefined || token.length === 0
    ? {}
    : { headers: Object.freeze({ Authorization: token }) };
}

function runtimeEnvironment(): TencentEnvironment {
  return typeof process === 'undefined' ? {} : process.env;
}
