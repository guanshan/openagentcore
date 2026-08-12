import type { JsonValue } from '../events/types.js';

export type TraceAttributeValue =
  boolean | number | string | readonly boolean[] | readonly number[] | readonly string[];

export type TraceAttributes = Readonly<Record<string, TraceAttributeValue>>;

export interface TraceCapabilities {
  readonly exporter: 'none' | 'otlp-http' | (string & {});
  /** True only when serializeContent is configured to redact opt-in content. */
  readonly contentCapture: boolean;
}

export interface TraceSpanContext {
  readonly traceId: string;
  readonly spanId: string;
}

export interface TraceSpanOptions {
  readonly kind: 'internal' | 'client';
  readonly parent?: TraceSpanContext;
  readonly attributes?: TraceAttributes;
  readonly startTimeUnixMs?: number;
}

export interface TraceSpanEndOptions {
  readonly status?: 'ok' | 'error';
  readonly errorType?: string;
  readonly attributes?: TraceAttributes;
  readonly endTimeUnixMs?: number;
}

export interface TraceSpan {
  readonly context: TraceSpanContext;
  setAttributes(attributes: TraceAttributes): void;
  end(options?: TraceSpanEndOptions): void;
}

export interface TraceMetric {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  readonly attributes?: TraceAttributes;
  readonly timeUnixMs?: number;
}

export interface TracePort {
  readonly capabilities: TraceCapabilities;
  startSpan(name: string, options: TraceSpanOptions): TraceSpan;
  recordMetric(metric: TraceMetric): void;
  /** Required when contentCapture is true; returns a redacted JSON representation. */
  serializeContent?(value: JsonValue): string;
  forceFlush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

const noopContext = Object.freeze({
  traceId: '00000000000000000000000000000000',
  spanId: '0000000000000000',
});

class NoopSpan implements TraceSpan {
  readonly context = noopContext;
  setAttributes(): void {}
  end(): void {}
}

/** Null Object used by AgentLoop so tracing never becomes a runtime dependency. */
export class NoopTracer implements TracePort {
  readonly capabilities = Object.freeze({ exporter: 'none', contentCapture: false } as const);
  readonly #span = new NoopSpan();

  startSpan(): TraceSpan {
    return this.#span;
  }

  recordMetric(): void {}

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}
