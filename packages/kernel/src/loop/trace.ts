import type { AgentEvent, JsonValue, ModelUsage } from '../events/types.js';
import type { StrategyMetricsSnapshot } from '../strategy/registry.js';
import type {
  TraceAttributeValue,
  TraceAttributes,
  TracePort,
  TraceSpan,
  TraceSpanContext,
} from '../ports/trace.js';

export type TraceErrorHandler = (error: unknown) => void | Promise<void>;

interface ActiveSpan {
  readonly span: TraceSpan;
  readonly startedAt: number;
}

export class AgentTraceLifecycle {
  readonly #trace: TracePort;
  readonly #onError: TraceErrorHandler | undefined;
  readonly #now: () => number;
  readonly #turns = new Map<string, ActiveSpan>();
  readonly #steps = new Map<string, ActiveSpan>();
  readonly #models = new Map<string, ActiveSpan>();
  readonly #tools = new Map<string, ActiveSpan>();

  constructor(trace: TracePort, onError?: TraceErrorHandler, now: () => number = Date.now) {
    this.#trace = trace;
    this.#onError = onError;
    this.#now = now;
  }

  observe(event: AgentEvent, strategyMetrics: readonly StrategyMetricsSnapshot[] = []): void {
    try {
      this.#observe(event, strategyMetrics);
    } catch (error) {
      this.#report(error);
    }
  }

  #observe(event: AgentEvent, strategyMetrics: readonly StrategyMetricsSnapshot[]): void {
    switch (event.type) {
      case 'turn.started': {
        const startedAt = this.#now();
        this.#turns.set(event.turnId, {
          startedAt,
          span: this.#trace.startSpan('invoke_agent', {
            kind: 'internal',
            startTimeUnixMs: startedAt,
            attributes: {
              'gen_ai.operation.name': 'invoke_agent',
              'gen_ai.conversation.id': event.sessionId,
              'openagentcore.tenant.id': event.tenantId,
              'openagentcore.turn.id': event.turnId,
            },
          }),
        });
        return;
      }
      case 'step.started': {
        const startedAt = this.#now();
        const parent = this.#turns.get(event.turnId)?.span.context;
        this.#steps.set(event.stepId, {
          startedAt,
          span: this.#trace.startSpan(`agent.step ${String(event.stepIndex)}`, {
            kind: 'internal',
            ...(parent === undefined ? {} : { parent }),
            startTimeUnixMs: startedAt,
            attributes: {
              'openagentcore.turn.id': event.turnId,
              'openagentcore.step.id': event.stepId,
              'openagentcore.step.index': event.stepIndex,
            },
          }),
        });
        return;
      }
      case 'model.request': {
        const startedAt = this.#now();
        const parent = this.#steps.get(event.stepId)?.span.context;
        const attributes: Record<string, TraceAttributeValue> = {
          'gen_ai.operation.name': 'chat',
          'gen_ai.conversation.id': event.sessionId,
          'openagentcore.step.id': event.stepId,
        };
        if (event.requestId !== undefined) attributes['gen_ai.request.id'] = event.requestId;
        const content = this.#content(event.assembled.messages as JsonValue);
        if (content !== undefined) attributes['gen_ai.input.messages'] = content;
        this.#models.set(event.stepId, {
          startedAt,
          span: this.#trace.startSpan('chat', {
            kind: 'client',
            ...(parent === undefined ? {} : { parent }),
            startTimeUnixMs: startedAt,
            attributes,
          }),
        });
        return;
      }
      case 'tool.call': {
        this.#finishModel(event.stepId);
        const startedAt = this.#now();
        const parent = this.#parentForStep(event.stepId);
        const attributes: Record<string, TraceAttributeValue> = {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': event.tool,
          'gen_ai.tool.call.id': event.callId,
          'openagentcore.step.id': event.stepId ?? '',
        };
        const content = this.#content(event.args);
        if (content !== undefined) attributes['gen_ai.tool.call.arguments'] = content;
        this.#tools.set(event.callId, {
          startedAt,
          span: this.#trace.startSpan(`execute_tool ${event.tool}`, {
            kind: 'internal',
            ...(parent === undefined ? {} : { parent }),
            startTimeUnixMs: startedAt,
            attributes,
          }),
        });
        return;
      }
      case 'tool.result': {
        const active = this.#tools.get(event.callId);
        if (active === undefined) return;
        const endedAt = this.#now();
        const attributes: Record<string, TraceAttributeValue> = {};
        const content = this.#content(event.result);
        if (content !== undefined) attributes['gen_ai.tool.call.result'] = content;
        const failed = event.outcome === 'failed' || event.outcome === 'denied';
        active.span.end({
          status: failed ? 'error' : 'ok',
          ...(failed ? { errorType: event.outcome ?? 'failed' } : {}),
          attributes,
          endTimeUnixMs: endedAt,
        });
        this.#duration('openagentcore.tool.duration', active.startedAt, endedAt, {
          'gen_ai.operation.name': 'execute_tool',
          ...(event.outcome === undefined ? {} : { 'openagentcore.tool.outcome': event.outcome }),
        });
        this.#tools.delete(event.callId);
        return;
      }
      case 'credential.used': {
        const active = this.#tools.get(event.callId);
        active?.span.setAttributes({
          'openagentcore.credential.scope': event.scope,
          'openagentcore.credential.attempt': event.attempt,
        });
        return;
      }
      case 'step.finished': {
        this.#finishModel(event.stepId);
        this.#recordUsage(event.usage);
        const active = this.#steps.get(event.stepId);
        if (active !== undefined) {
          const endedAt = this.#now();
          active.span.end({
            status: event.outcome === 'succeeded' ? 'ok' : 'error',
            ...(event.outcome === 'succeeded' ? {} : { errorType: event.outcome }),
            endTimeUnixMs: endedAt,
          });
          this.#duration('openagentcore.step.duration', active.startedAt, endedAt, {
            'openagentcore.step.outcome': event.outcome,
          });
          this.#steps.delete(event.stepId);
        }
        return;
      }
      case 'turn.finished': {
        const active = this.#turns.get(event.turnId);
        if (active !== undefined) {
          const endedAt = this.#now();
          active.span.end({
            status: failureStopReasons.has(event.stopReason) ? 'error' : 'ok',
            ...(failureStopReasons.has(event.stopReason) ? { errorType: event.stopReason } : {}),
            attributes: { 'openagentcore.stop.reason': event.stopReason },
            endTimeUnixMs: endedAt,
          });
          this.#duration('openagentcore.turn.duration', active.startedAt, endedAt, {
            'openagentcore.stop.reason': event.stopReason,
          });
          this.#turns.delete(event.turnId);
        }
        this.#recordStrategyMetrics(strategyMetrics);
        return;
      }
      default:
        return;
    }
  }

  #finishModel(stepId: string | undefined): void {
    if (stepId === undefined) return;
    const active = this.#models.get(stepId);
    if (active === undefined) return;
    const endedAt = this.#now();
    active.span.end({ status: 'ok', endTimeUnixMs: endedAt });
    this.#duration('gen_ai.client.operation.duration', active.startedAt, endedAt, {
      'gen_ai.operation.name': 'chat',
    });
    this.#models.delete(stepId);
  }

  #recordUsage(usage: ModelUsage): void {
    this.#trace.recordMetric({
      name: 'gen_ai.client.token.usage',
      value: usage.inputTokens,
      unit: '{token}',
      attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.token.type': 'input' },
    });
    this.#trace.recordMetric({
      name: 'gen_ai.client.token.usage',
      value: usage.outputTokens,
      unit: '{token}',
      attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.token.type': 'output' },
    });
    if (usage.cost !== undefined) {
      this.#trace.recordMetric({
        name: 'openagentcore.model.cost',
        value: usage.cost.amount,
        unit: usage.cost.currency,
        attributes: { 'gen_ai.operation.name': 'chat' },
      });
    }
  }

  #recordStrategyMetrics(snapshots: readonly StrategyMetricsSnapshot[]): void {
    for (const snapshot of snapshots) {
      for (const [metric, value] of Object.entries(snapshot.metrics)) {
        this.#trace.recordMetric({
          name: 'openagentcore.strategy.effect',
          value,
          unit: '1',
          attributes: {
            'openagentcore.strategy.kind': snapshot.kind,
            'openagentcore.strategy.name': snapshot.name,
            'openagentcore.strategy.metric': metric,
          },
        });
      }
    }
  }

  #duration(name: string, startedAt: number, endedAt: number, attributes: TraceAttributes): void {
    this.#trace.recordMetric({
      name,
      value: Math.max(0, endedAt - startedAt) / 1_000,
      unit: 's',
      attributes,
      timeUnixMs: endedAt,
    });
  }

  #content(value: JsonValue): string | undefined {
    if (!this.#trace.capabilities.contentCapture) return undefined;
    if (this.#trace.serializeContent === undefined) {
      throw new Error('TracePort declares contentCapture but does not implement serializeContent.');
    }
    return this.#trace.serializeContent(value);
  }

  #parentForStep(stepId: string | undefined): TraceSpanContext | undefined {
    return stepId === undefined ? undefined : this.#steps.get(stepId)?.span.context;
  }

  #report(error: unknown): void {
    if (this.#onError === undefined) return;
    try {
      const reporting = this.#onError(error);
      if (reporting !== undefined) void reporting.catch(() => undefined);
    } catch {
      // Observability failures are isolated from the durable AgentLoop.
    }
  }
}

const failureStopReasons = new Set(['model-error', 'tool-error', 'permission-denied']);
