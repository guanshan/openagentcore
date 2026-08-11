import type { EventLog } from '../events/event-log.js';
import {
  materializeMessageHistory,
  projectMessageHistory,
  type MessageHistoryItem,
  type MessageProjectionEntry,
} from '../events/projection.js';
import type { JsonObject, JsonValue } from '../events/types.js';
import type {
  ModelMessage,
  ModelPort,
  ModelRequest,
  ModelToolDefinition,
  ModelToolUse,
} from '../ports/model.js';
import type { CompactionEntry } from '../strategy/builtins.js';
import type { Tool, ToolRegistry } from '../tools/tool.js';
import type {
  ContextMiddlewareContext,
  MiddlewareBaseContext,
  MiddlewareRegistry,
} from './middleware.js';

export const PROMPTED_TOOL_CALL_PREFIX = 'OAC_TOOL_CALL ';

export interface ContextRuntime {
  readonly eventLog: EventLog;
  readonly model: ModelPort;
  readonly tools: ToolRegistry;
  readonly middleware: MiddlewareRegistry;
}

export interface AssembledContext {
  readonly messages: readonly ModelMessage[];
  readonly definitions: readonly ModelToolDefinition[];
  readonly toolUse: ModelToolUse;
  readonly capabilityDowngrades: readonly string[];
}

export async function assembleContext(
  runtime: ContextRuntime,
  turnId: string,
  stepId: string,
  signal: AbortSignal,
): Promise<AssembledContext> {
  const projection = await projectMessageHistory(runtime.eventLog.read(0));
  let messages = historyToModelMessages(materializeMessageHistory(projection));
  const memory = await runMemoryPipeline(
    runtime,
    'read',
    turnId,
    stepId,
    signal,
    messagesToJson(messages),
  );
  const remembered = jsonToModelMessages(memory);
  if (remembered !== undefined) {
    messages = remembered;
  }

  const definitions = runtime.tools.list().map(toolDefinition);
  const toolUse = definitions.length === 0 ? 'none' : runtime.model.capabilities.toolUse;
  const capabilityDowngrades =
    definitions.length > 0 && toolUse !== 'native' ? [`tool-use:native->${toolUse}`] : [];
  if (toolUse === 'prompted') {
    messages = [
      {
        role: 'system',
        content:
          `${PROMPTED_TOOL_CALL_PREFIX}{"callId":"...","tool":"...","args":{}}` +
          ' emits one complete tool call.',
      },
      ...messages,
    ];
  }

  const context: ContextMiddlewareContext = {
    ...middlewareContext(runtime.eventLog, signal, turnId, stepId),
    messages: [...messages],
    tools: [...definitions],
    capabilityDowngrades: [...capabilityDowngrades],
  };
  await runtime.middleware.run('context', context);
  return {
    messages: context.messages,
    definitions: context.tools,
    toolUse,
    capabilityDowngrades: context.capabilityDowngrades,
  };
}

export async function runMemoryPipeline(
  runtime: Pick<ContextRuntime, 'eventLog' | 'middleware'>,
  operation: 'read' | 'write',
  turnId: string,
  stepId: string,
  signal: AbortSignal,
  value?: JsonValue,
): Promise<JsonValue | undefined> {
  const context = {
    ...middlewareContext(runtime.eventLog, signal, turnId, stepId),
    operation,
    key: `${runtime.eventLog.sessionId}:message-history`,
    value,
  };
  await runtime.middleware.run('memory', context);
  return context.value;
}

export function middlewareContext(
  eventLog: EventLog,
  signal: AbortSignal,
  turnId: string,
  stepId: string | undefined,
): MiddlewareBaseContext {
  return {
    signal,
    tenantId: eventLog.tenantId,
    sessionId: eventLog.sessionId,
    turnId,
    stepId,
  };
}

export function modelRequestToJson(request: ModelRequest): JsonObject {
  return {
    messages: messagesToJson(request.messages),
    tools: request.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: structuredClone(tool.inputSchema),
    })),
    toolUse: request.toolUse,
    ...(request.metadata === undefined ? {} : { metadata: structuredClone(request.metadata) }),
  };
}

export function messagesToJson(messages: readonly ModelMessage[]): JsonValue {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
  }));
}

export function historyToModelMessages(history: readonly MessageHistoryItem[]): ModelMessage[] {
  return history.map((item) => {
    switch (item.kind) {
      case 'message':
        return { role: item.role, content: item.content };
      case 'tool-call':
        return {
          role: 'assistant',
          content: `${PROMPTED_TOOL_CALL_PREFIX}${JSON.stringify({
            callId: item.callId,
            tool: item.tool,
            args: item.args,
          })}`,
        };
      case 'tool-result':
        return {
          role: 'tool',
          content: JSON.stringify(item.result),
          toolCallId: item.callId,
        };
      case 'summary':
        return { role: 'system', content: item.content };
    }
  });
}

export function compactionEntries(
  entries: readonly MessageProjectionEntry[],
): readonly CompactionEntry[] {
  const bySeq = new Map<number, string[]>();
  for (const entry of entries) {
    if (entry.kind === 'summary') {
      continue;
    }
    const content =
      entry.kind === 'message'
        ? entry.content
        : entry.kind === 'tool-call'
          ? `${entry.tool}(${JSON.stringify(entry.args)})`
          : JSON.stringify(entry.result);
    const contents = bySeq.get(entry.sourceSeq) ?? [];
    contents.push(content);
    bySeq.set(entry.sourceSeq, contents);
  }
  return [...bySeq]
    .sort(([left], [right]) => left - right)
    .map(([sourceSeq, contents]) => ({ sourceSeq, content: contents.join('\n') }));
}

function jsonToModelMessages(value: JsonValue | undefined): ModelMessage[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const messages: ModelMessage[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return undefined;
    }
    const role = item['role'];
    const content = item['content'];
    if (
      (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') ||
      typeof content !== 'string'
    ) {
      return undefined;
    }
    const name = item['name'];
    const toolCallId = item['toolCallId'];
    if (
      (name !== undefined && typeof name !== 'string') ||
      (toolCallId !== undefined && typeof toolCallId !== 'string')
    ) {
      return undefined;
    }
    messages.push({
      role,
      content,
      ...(name === undefined ? {} : { name }),
      ...(toolCallId === undefined ? {} : { toolCallId }),
    });
  }
  return messages;
}

function toolDefinition(tool: Tool): ModelToolDefinition {
  const description = tool.permission.description;
  return {
    name: tool.name,
    ...(description === undefined ? {} : { description }),
    inputSchema: structuredClone(tool.inputSchema),
  };
}
