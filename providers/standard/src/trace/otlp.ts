import { randomBytes } from 'node:crypto';

import type {
  JsonValue,
  TraceAttributeValue,
  TraceAttributes,
  TraceMetric,
  TracePort,
  TraceSpan,
  TraceSpanContext,
  TraceSpanEndOptions,
  TraceSpanOptions,
} from '@openagentcore/kernel';

import { redactSensitiveContent } from '../model/sensitive.js';

export interface OtlpTracePortOptions {
  /** OTLP/HTTP base URL or a concrete /v1/traces endpoint. */
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly resourceAttributes?: TraceAttributes;
  readonly captureContent?: boolean;
  readonly additionalSensitiveKeys?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

interface CompletedSpan {
  readonly name: string;
  readonly kind: TraceSpanOptions['kind'];
  readonly context: TraceSpanContext;
  readonly parent: TraceSpanContext | undefined;
  readonly attributes: TraceAttributes;
  readonly startTimeUnixMs: number;
  readonly endTimeUnixMs: number;
  readonly status: 'ok' | 'error';
  readonly errorType: string | undefined;
}

export class OtlpTracePort implements TracePort {
  readonly capabilities: TracePort['capabilities'];

  readonly #tracesEndpoint: string;
  readonly #metricsEndpoint: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #resourceAttributes: TraceAttributes;
  readonly #additionalSensitiveKeys: readonly string[];
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #spans: CompletedSpan[] = [];
  readonly #metrics: TraceMetric[] = [];
  #flushing: Promise<void> | undefined;
  #closed = false;

  constructor(options: OtlpTracePortOptions) {
    const endpoints = otlpEndpoints(options.endpoint);
    this.#tracesEndpoint = endpoints.traces;
    this.#metricsEndpoint = endpoints.metrics;
    this.#headers = Object.freeze({ ...(options.headers ?? {}) });
    this.#resourceAttributes = Object.freeze({
      'service.name': 'openagentcore',
      ...(options.resourceAttributes ?? {}),
    });
    this.#additionalSensitiveKeys = Object.freeze([...(options.additionalSensitiveKeys ?? [])]);
    if (this.#additionalSensitiveKeys.some((key) => key.length === 0)) {
      throw new Error('Trace sensitive keys must be non-empty.');
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.capabilities = Object.freeze({
      exporter: 'otlp-http',
      contentCapture: options.captureContent ?? false,
    });
  }

  startSpan(name: string, options: TraceSpanOptions): TraceSpan {
    this.#assertOpen();
    if (name.length === 0) throw new Error('Trace span name must be non-empty.');
    const startTimeUnixMs = validTime(options.startTimeUnixMs ?? this.#now(), 'span start');
    const context = Object.freeze({
      traceId: options.parent?.traceId ?? randomBytes(16).toString('hex'),
      spanId: randomBytes(8).toString('hex'),
    });
    validateContext(context);
    if (options.parent !== undefined) validateContext(options.parent);
    return new OtlpSpan(
      name,
      options.kind,
      context,
      options.parent,
      options.attributes ?? {},
      startTimeUnixMs,
      this.#now,
      (span) => this.#spans.push(span),
    );
  }

  recordMetric(metric: TraceMetric): void {
    this.#assertOpen();
    if (metric.name.length === 0 || metric.unit.length === 0) {
      throw new Error('Trace metric name and unit must be non-empty.');
    }
    if (!Number.isFinite(metric.value)) throw new Error('Trace metric value must be finite.');
    validateAttributes(metric.attributes ?? {});
    this.#metrics.push(structuredClone(metric));
  }

  serializeContent(value: JsonValue): string {
    if (!this.capabilities.contentCapture) {
      throw new Error('Trace content capture is not enabled.');
    }
    return JSON.stringify(redactSensitiveContent(value, this.#additionalSensitiveKeys));
  }

  async forceFlush(): Promise<void> {
    this.#assertOpen();
    if (this.#flushing !== undefined) return this.#flushing;
    this.#flushing = this.#flush();
    try {
      await this.#flushing;
    } finally {
      this.#flushing = undefined;
    }
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return;
    await this.forceFlush();
    this.#closed = true;
  }

  async #flush(): Promise<void> {
    const spans = this.#spans.splice(0);
    if (spans.length > 0) {
      try {
        await this.#export(this.#tracesEndpoint, tracePayload(spans, this.#resourceAttributes));
      } catch (error) {
        this.#spans.unshift(...spans);
        throw error;
      }
    }

    const metrics = this.#metrics.splice(0);
    if (metrics.length > 0) {
      try {
        await this.#export(
          this.#metricsEndpoint,
          metricPayload(metrics, this.#resourceAttributes, this.#now),
        );
      } catch (error) {
        this.#metrics.unshift(...metrics);
        throw error;
      }
    }
  }

  async #export(endpoint: string, payload: unknown): Promise<void> {
    const response = await this.#fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.#headers },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`OTLP/HTTP export failed with status ${String(response.status)}.`);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('OTLP TracePort is shut down.');
  }
}

class OtlpSpan implements TraceSpan {
  readonly context: TraceSpanContext;

  readonly #name: string;
  readonly #kind: TraceSpanOptions['kind'];
  readonly #parent: TraceSpanContext | undefined;
  readonly #attributes: Record<string, TraceAttributeValue>;
  readonly #startTimeUnixMs: number;
  readonly #now: () => number;
  readonly #complete: (span: CompletedSpan) => void;
  #ended = false;

  constructor(
    name: string,
    kind: TraceSpanOptions['kind'],
    context: TraceSpanContext,
    parent: TraceSpanContext | undefined,
    attributes: TraceAttributes,
    startTimeUnixMs: number,
    now: () => number,
    complete: (span: CompletedSpan) => void,
  ) {
    validateAttributes(attributes);
    this.#name = name;
    this.#kind = kind;
    this.context = context;
    this.#parent = parent;
    this.#attributes = { ...structuredClone(attributes) };
    this.#startTimeUnixMs = startTimeUnixMs;
    this.#now = now;
    this.#complete = complete;
  }

  setAttributes(attributes: TraceAttributes): void {
    if (this.#ended) return;
    validateAttributes(attributes);
    Object.assign(this.#attributes, structuredClone(attributes));
  }

  end(options: TraceSpanEndOptions = {}): void {
    if (this.#ended) return;
    this.#ended = true;
    validateAttributes(options.attributes ?? {});
    Object.assign(this.#attributes, structuredClone(options.attributes ?? {}));
    if (options.errorType !== undefined) this.#attributes['error.type'] = options.errorType;
    const endTimeUnixMs = Math.max(
      this.#startTimeUnixMs,
      validTime(options.endTimeUnixMs ?? this.#now(), 'span end'),
    );
    this.#complete({
      name: this.#name,
      kind: this.#kind,
      context: this.context,
      parent: this.#parent,
      attributes: Object.freeze({ ...this.#attributes }),
      startTimeUnixMs: this.#startTimeUnixMs,
      endTimeUnixMs,
      status: options.status ?? 'ok',
      errorType: options.errorType,
    });
  }
}

function tracePayload(spans: readonly CompletedSpan[], resource: TraceAttributes): unknown {
  return {
    resourceSpans: [
      {
        resource: { attributes: otlpAttributes(resource) },
        scopeSpans: [
          {
            scope: { name: '@openagentcore/standard', version: '0.1.0' },
            spans: spans.map((span) => ({
              traceId: span.context.traceId,
              spanId: span.context.spanId,
              ...(span.parent === undefined ? {} : { parentSpanId: span.parent.spanId }),
              name: span.name,
              kind: span.kind === 'client' ? 3 : 1,
              startTimeUnixNano: unixNano(span.startTimeUnixMs),
              endTimeUnixNano: unixNano(span.endTimeUnixMs),
              attributes: otlpAttributes(span.attributes),
              status: {
                code: span.status === 'error' ? 2 : 1,
                ...(span.errorType === undefined ? {} : { message: span.errorType }),
              },
            })),
          },
        ],
      },
    ],
  };
}

function metricPayload(
  metrics: readonly TraceMetric[],
  resource: TraceAttributes,
  now: () => number,
): unknown {
  const grouped = new Map<
    string,
    { readonly name: string; readonly unit: string; points: unknown[] }
  >();
  for (const metric of metrics) {
    const key = `${metric.name}\u0000${metric.unit}`;
    const entry = grouped.get(key) ?? { name: metric.name, unit: metric.unit, points: [] };
    entry.points.push({
      attributes: otlpAttributes(metric.attributes ?? {}),
      timeUnixNano: unixNano(validTime(metric.timeUnixMs ?? now(), 'metric time')),
      asDouble: metric.value,
    });
    grouped.set(key, entry);
  }
  return {
    resourceMetrics: [
      {
        resource: { attributes: otlpAttributes(resource) },
        scopeMetrics: [
          {
            scope: { name: '@openagentcore/standard', version: '0.1.0' },
            metrics: [...grouped.values()].map((metric) => ({
              name: metric.name,
              unit: metric.unit,
              gauge: { dataPoints: metric.points },
            })),
          },
        ],
      },
    ],
  };
}

function otlpAttributes(attributes: TraceAttributes): readonly unknown[] {
  validateAttributes(attributes);
  return Object.entries(attributes).map(([key, value]) => ({ key, value: otlpValue(value) }));
}

function otlpValue(value: TraceAttributeValue): unknown {
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((nested) => otlpScalar(nested)) } };
  }
  return otlpScalar(value as boolean | number | string);
}

function otlpScalar(value: boolean | number | string): unknown {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return { doubleValue: value };
  return { stringValue: value };
}

function validateAttributes(attributes: TraceAttributes): void {
  for (const [key, value] of Object.entries(attributes)) {
    if (key.length === 0) throw new Error('Trace attribute names must be non-empty.');
    const values = Array.isArray(value) ? value : [value];
    for (const nested of values) {
      if (
        !['boolean', 'number', 'string'].includes(typeof nested) ||
        (typeof nested === 'number' && !Number.isFinite(nested))
      ) {
        throw new Error(`Trace attribute ${key} has an unsupported value.`);
      }
    }
  }
}

function validateContext(context: TraceSpanContext): void {
  if (!/^[0-9a-f]{32}$/.test(context.traceId) || !/^[0-9a-f]{16}$/.test(context.spanId)) {
    throw new Error('Trace context IDs must be lowercase hexadecimal OTLP identifiers.');
  }
}

function validTime(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${label} must be finite and non-negative.`);
  return value;
}

function unixNano(unixMs: number): string {
  return BigInt(Math.trunc(unixMs * 1_000_000)).toString();
}

function otlpEndpoints(endpoint: string): { readonly traces: string; readonly metrics: string } {
  const url = new URL(endpoint);
  const path = url.pathname.replace(/\/$/, '');
  if (path.endsWith('/v1/traces')) {
    const base = endpoint.slice(0, -'/v1/traces'.length);
    return { traces: endpoint, metrics: `${base}/v1/metrics` };
  }
  const base = endpoint.replace(/\/$/, '');
  return { traces: `${base}/v1/traces`, metrics: `${base}/v1/metrics` };
}
