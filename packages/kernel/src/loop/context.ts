import type { EventLog } from '../events/event-log.js';
import {
  materializeMessageHistory,
  projectMessageHistory,
  type MessageHistoryItem,
  type MessageProjectionEntry,
} from '../events/projection.js';
import type {
  ContextAssembly,
  ContextAssemblyMessage,
  ContextSegment,
  ContextSegmentSource,
  ContextStageId,
  ContextStageSnapshot,
  JsonObject,
  JsonValue,
  UserInput,
} from '../events/types.js';
import type {
  ModelMessage,
  ModelMessageToolCall,
  ModelPort,
  ModelRequest,
  ModelToolDefinition,
  ModelToolUse,
} from '../ports/model.js';
import type { Prompt, PromptRegistrySnapshot } from '../prompts/registry.js';
import type { CompactionEntry } from '../strategy/builtins.js';
import type { Tool, ToolRegistry } from '../tools/tool.js';
import type {
  ContextMiddlewareContext,
  MiddlewareBaseContext,
  MiddlewareExecutionMode,
  MiddlewareRegistry,
} from './middleware.js';

export const PROMPTED_TOOL_CALL_PREFIX = 'OAC_TOOL_CALL ';
export const PROMPTED_TOOL_RESULT_PREFIX = 'OAC_TOOL_RESULT ';

const SYSTEM_SLOT_IDS = [
  'identity',
  'capabilities',
  'tool-protocol',
  'project-context',
  'skills',
  'user-custom',
] as const;

type SystemSlotId = (typeof SYSTEM_SLOT_IDS)[number];

export interface ContextRuntime {
  readonly eventLog: EventLog;
  readonly model: ModelPort;
  readonly tools: ToolRegistry;
  readonly prompts: PromptRegistrySnapshot;
  readonly middleware: MiddlewareRegistry;
}

export interface ContextAssemblyDraft {
  readonly messages: readonly ModelMessage[];
  readonly definitions: readonly ModelToolDefinition[];
  readonly toolUse: ModelToolUse;
  readonly capabilityDowngrades: readonly string[];
  readonly promptRevision: number;
  readonly stages: readonly ContextStageSnapshot[];
  readonly segments: readonly ContextSegment[];
}

export interface AssembleContextOptions {
  readonly input?: UserInput;
  readonly mode?: MiddlewareExecutionMode;
}

export async function assembleContext(
  runtime: ContextRuntime,
  turnId: string,
  stepId: string,
  signal: AbortSignal,
  options: AssembleContextOptions = {},
): Promise<ContextAssemblyDraft> {
  const mode = options.mode ?? 'execute';
  const prompts = runtime.prompts;
  const definitions = runtime.tools.list().map(toolDefinition);
  const toolUse = definitions.length === 0 ? 'none' : runtime.model.capabilities.toolUse;
  const capabilityDowngrades =
    definitions.length > 0 && toolUse !== 'native' ? [`tool-use:native->${toolUse}`] : [];
  const projection = await projectMessageHistory(runtime.eventLog.read(0));
  const history = materializeMessageHistory(projection);
  const historyAssembly = assembleHistory(history, toolUse);
  let messages = historyAssembly.messages;
  let segments = historyAssembly.segments;
  if (options.input !== undefined) {
    const messageIndex = messages.length;
    messages = [...messages, { role: 'user', content: options.input.content }];
    segments = [
      ...segments,
      {
        id: `history:dry-run-input:${messageIndex}`,
        stage: 'history',
        role: 'user',
        content: options.input.content,
        source: { kind: 'dry-run-input', id: 'input' },
        tokenCount: null,
        messageIndex,
      },
    ];
  }
  const stages: ContextStageSnapshot[] = [
    stageSnapshot('history', messages.length === 0 ? 'noop' : 'applied', messages, segments),
  ];

  const beforeMemory = messages;
  const memory = await runMemoryPipeline(
    runtime,
    'read',
    turnId,
    stepId,
    signal,
    messagesToJson(messages),
    mode,
  );
  const remembered = jsonToModelMessages(memory);
  if (remembered !== undefined) {
    messages = remembered;
  }
  const memoryChanged = !jsonEqual(beforeMemory, messages);
  if (memoryChanged) {
    segments = reconcileMessageSegments(beforeMemory, segments, messages, 'memory', {
      kind: 'memory',
      id: `${runtime.eventLog.sessionId}:message-history`,
    });
  }
  stages.push(stageSnapshot('memory', memoryChanged ? 'applied' : 'noop', messages, segments));

  stages.push(stageSnapshot('skills', 'noop', messages, segments));
  stages.push(
    stageSnapshot(
      'compaction',
      history.some((item) => item.kind === 'summary') ? 'applied' : 'noop',
      messages,
      segments,
    ),
  );

  const slotAssembly = assembleSystemSlots(
    prompts,
    toolUse,
    definitions,
    projection.entries.some((entry) => entry.kind === 'tool-result' && entry.outcome === 'failed'),
  );
  if (slotAssembly.message !== undefined) {
    messages = [slotAssembly.message, ...messages];
    segments = [
      ...slotAssembly.segments,
      ...segments.map((segment) => ({ ...segment, messageIndex: segment.messageIndex + 1 })),
    ];
  }
  stages.push(
    stageSnapshot(
      'slots',
      slotAssembly.message === undefined ? 'noop' : 'applied',
      messages,
      segments,
    ),
  );

  const beforeContextMiddleware = structuredClone(messages);
  const beforeContextTools = structuredClone(definitions);
  const beforeCapabilityDowngrades = structuredClone(capabilityDowngrades);
  const context: ContextMiddlewareContext = {
    ...middlewareContext(runtime.eventLog, signal, turnId, stepId, mode),
    messages: [...messages],
    tools: [...definitions],
    capabilityDowngrades: [...capabilityDowngrades],
  };
  await runtime.middleware.run('context', context);
  const contextMessagesChanged = !jsonEqual(beforeContextMiddleware, context.messages);
  const contextChanged =
    contextMessagesChanged ||
    !jsonEqual(beforeContextTools, context.tools) ||
    !jsonEqual(beforeCapabilityDowngrades, context.capabilityDowngrades);
  if (contextMessagesChanged) {
    segments = reconcileMessageSegments(
      beforeContextMiddleware,
      segments,
      context.messages,
      'context-middleware',
      { kind: 'middleware', id: 'context', middlewareKind: 'context' },
    );
  }
  stages.push(
    stageSnapshot(
      'context-middleware',
      contextChanged ? 'applied' : 'noop',
      context.messages,
      segments,
    ),
  );

  return {
    messages: structuredClone(context.messages),
    definitions: structuredClone(context.tools),
    toolUse,
    capabilityDowngrades: structuredClone(context.capabilityDowngrades),
    promptRevision: prompts.revision,
    stages,
    segments,
  };
}

export function finalizeContextAssembly(
  draft: ContextAssemblyDraft,
  request: ModelRequest,
): ContextAssembly {
  const modelChanged = !jsonEqual(draft.messages, request.messages);
  const segments = modelChanged
    ? reconcileMessageSegments(
        draft.messages,
        draft.segments,
        request.messages,
        'model-middleware',
        { kind: 'middleware', id: 'model', middlewareKind: 'model' },
      )
    : structuredClone(draft.segments);
  const stages = [
    ...structuredClone(draft.stages),
    stageSnapshot(
      'model-middleware',
      modelChanged ? 'applied' : 'noop',
      request.messages,
      segments,
    ),
  ];
  return {
    messages: request.messages.map(messageToAssembly),
    tools: request.tools.map(toolToAssembly),
    toolUse: request.toolUse,
    ...(request.metadata === undefined ? {} : { metadata: structuredClone(request.metadata) }),
    stages,
    segments,
    totalTokens: null,
    promptRevision: draft.promptRevision,
    capabilityDowngrades: structuredClone(draft.capabilityDowngrades),
  };
}

export function contextDraftToModelRequest(
  draft: ContextAssemblyDraft,
  turnId: string,
  stepId: string,
): ModelRequest {
  const metadata: JsonObject =
    draft.toolUse === 'prompted'
      ? { turnId, stepId, toolProtocol: 'oac-prompted-tool-call-v0' }
      : { turnId, stepId };
  return {
    messages: structuredClone(draft.messages),
    tools: draft.toolUse === 'none' ? [] : structuredClone(draft.definitions),
    toolUse: draft.toolUse,
    metadata,
  };
}

export async function measureContextAssembly(
  model: ModelPort,
  assembly: ContextAssembly,
  signal: AbortSignal,
): Promise<ContextAssembly> {
  const measuredSegments: ContextSegment[] = [];
  for (const segment of assembly.segments) {
    const finalMessage = assembly.messages[segment.messageIndex];
    if (finalMessage === undefined) {
      throw new Error(`Context segment ${segment.id} refers to a missing message.`);
    }
    const firstSegmentForMessage = assembly.segments.find(
      (candidate) => candidate.messageIndex === segment.messageIndex,
    );
    const tokenCount = await model.countTokens(
      {
        messages: [
          {
            role: segment.role,
            content: segment.content,
            ...(finalMessage.name === undefined ? {} : { name: finalMessage.name }),
            ...(finalMessage.toolCallId === undefined
              ? {}
              : { toolCallId: finalMessage.toolCallId }),
            ...(finalMessage.toolCalls === undefined || firstSegmentForMessage?.id !== segment.id
              ? {}
              : { toolCalls: structuredClone(finalMessage.toolCalls) }),
          },
        ],
        tools: [],
        toolUse: 'none',
      },
      signal,
    );
    measuredSegments.push({ ...structuredClone(segment), tokenCount });
  }
  const request = modelRequestFromJson(assembly);
  if (request === undefined) {
    throw new Error('Context assembly does not contain a valid model request.');
  }
  const totalTokens = await model.countTokens(request, signal);
  const tokensBySegment = new Map(
    measuredSegments.map((segment) => [segment.id, segment.tokenCount ?? 0]),
  );
  const stages = assembly.stages.map((stage) => ({
    ...structuredClone(stage),
    tokenCount: stage.segmentIds.reduce(
      (total, segmentId) => total + (tokensBySegment.get(segmentId) ?? 0),
      0,
    ),
  }));
  return {
    ...structuredClone(assembly),
    stages,
    segments: measuredSegments,
    totalTokens,
  };
}

export function formatContextAssembly(assembly: ContextAssembly): string {
  const lines = [
    'Context assembly (dry-run)',
    `Prompt revision: ${assembly.promptRevision}`,
    `Tool use: ${assembly.toolUse}`,
    `Capability downgrades: ${assembly.capabilityDowngrades.join(', ') || 'none'}`,
    `Total tokens: ${formatTokenCount(assembly.totalTokens)}`,
    '',
    'Stages',
  ];
  assembly.stages.forEach((stage, index) => {
    lines.push(
      `${index + 1}. ${stage.stage} — ${stage.status} — ${stage.messages.length} message(s), ${stage.segmentIds.length} segment(s), ${formatTokenCount(stage.tokenCount)} token(s)`,
    );
  });
  lines.push('', 'Final messages');
  assembly.messages.forEach((message, messageIndex) => {
    const messageSegments = assembly.segments.filter(
      (segment) => segment.messageIndex === messageIndex,
    );
    const messageTokens = messageSegments.reduce(
      (total, segment) => total + (segment.tokenCount ?? 0),
      0,
    );
    lines.push(`[${messageIndex}] ${message.role} — ${messageTokens} token(s)`, message.content);
    for (const segment of messageSegments) {
      lines.push(
        `  - ${segment.id} | ${formatSource(segment.source)} | ${formatTokenCount(segment.tokenCount)} token(s)`,
      );
    }
  });
  lines.push('', 'Tools');
  if (assembly.tools.length === 0) {
    lines.push('(none)');
  } else {
    assembly.tools.forEach((tool) => lines.push(`- ${tool.name}`));
  }
  return lines.join('\n');
}

export async function runMemoryPipeline(
  runtime: Pick<ContextRuntime, 'eventLog' | 'middleware'>,
  operation: 'read' | 'write',
  turnId: string,
  stepId: string,
  signal: AbortSignal,
  value?: JsonValue,
  mode: MiddlewareExecutionMode = 'execute',
): Promise<JsonValue | undefined> {
  const context = {
    ...middlewareContext(runtime.eventLog, signal, turnId, stepId, mode),
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
  mode: MiddlewareExecutionMode = 'execute',
): MiddlewareBaseContext {
  return {
    signal,
    tenantId: eventLog.tenantId,
    sessionId: eventLog.sessionId,
    turnId,
    stepId,
    mode,
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

export function modelRequestFromJson(value: JsonObject): ModelRequest | undefined {
  const messages = jsonToModelMessages(value['messages']);
  const tools = jsonToModelTools(value['tools']);
  const toolUse = value['toolUse'];
  const metadata = value['metadata'];
  if (
    messages === undefined ||
    tools === undefined ||
    (toolUse !== 'native' && toolUse !== 'prompted' && toolUse !== 'none') ||
    (metadata !== undefined && !isJsonObject(metadata))
  ) {
    return undefined;
  }
  return {
    messages,
    tools,
    toolUse,
    ...(metadata === undefined ? {} : { metadata: structuredClone(metadata) }),
  };
}

export function messagesToJson(messages: readonly ModelMessage[]): JsonValue {
  return messages.map((message) => messageToAssembly(message));
}

export function historyToModelMessages(
  history: readonly MessageHistoryItem[],
  toolUse: ModelToolUse,
): ModelMessage[] {
  return assembleHistory(history, toolUse).messages;
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

function assembleHistory(
  history: readonly MessageHistoryItem[],
  toolUse: ModelToolUse,
): { readonly messages: ModelMessage[]; readonly segments: ContextSegment[] } {
  const messages: ModelMessage[] = [];
  const segments: ContextSegment[] = [];
  const messageStepIds: Array<string | undefined> = [];

  for (const item of history) {
    const message = historyToModelMessage(item, toolUse);
    let messageIndex = messages.length;
    const previous = messages.at(-1);
    const previousStepId = messageStepIds.at(-1);
    if (
      toolUse === 'native' &&
      item.kind === 'tool-call' &&
      previous?.role === 'assistant' &&
      item.stepId !== undefined &&
      previousStepId === item.stepId
    ) {
      messageIndex -= 1;
      messages[messageIndex] = {
        ...previous,
        toolCalls: [...(previous.toolCalls ?? []), ...(message.toolCalls ?? [])],
      };
    } else {
      messages.push(message);
      messageStepIds.push(
        item.kind === 'message' && item.role === 'assistant'
          ? item.stepId
          : item.kind === 'tool-call'
            ? item.stepId
            : undefined,
      );
    }
    segments.push(historySegment(item, messageIndex, toolUse));
  }

  return { messages, segments };
}

function historyToModelMessage(item: MessageHistoryItem, toolUse: ModelToolUse): ModelMessage {
  switch (item.kind) {
    case 'message':
      return { role: item.role, content: item.content };
    case 'tool-call':
      if (toolUse === 'native') {
        return {
          role: 'assistant',
          content: '',
          toolCalls: [{ callId: item.callId, tool: item.tool, args: structuredClone(item.args) }],
        };
      }
      return {
        role: 'assistant',
        content: `${PROMPTED_TOOL_CALL_PREFIX}${JSON.stringify({
          callId: item.callId,
          tool: item.tool,
          args: item.args,
        })}`,
      };
    case 'tool-result':
      if (toolUse !== 'native') {
        return {
          role: 'user',
          content: `${PROMPTED_TOOL_RESULT_PREFIX}${JSON.stringify({
            callId: item.callId,
            result: item.result,
          })}`,
        };
      }
      return {
        role: 'tool',
        content: JSON.stringify(item.result),
        toolCallId: item.callId,
      };
    case 'summary':
      return { role: 'system', content: item.content };
  }
}

function historySegment(
  item: MessageHistoryItem,
  messageIndex: number,
  toolUse: ModelToolUse,
): ContextSegment {
  const message = historyToModelMessage(item, toolUse);
  const source: ContextSegmentSource =
    item.kind === 'summary'
      ? {
          kind: 'compaction',
          id: `compaction.applied@${item.sourceSeqs.at(-1) ?? 'unknown'}`,
          sourceSeqs: [...item.sourceSeqs],
          ...(item.strategy === undefined ? {} : { strategy: item.strategy }),
        }
      : { kind: 'event', sourceSeqs: [...item.sourceSeqs] };
  return {
    id: `history:${messageIndex}`,
    stage: 'history',
    role: message.role,
    content: message.content,
    source,
    tokenCount: null,
    messageIndex,
  };
}

function assembleSystemSlots(
  prompts: PromptRegistrySnapshot,
  toolUse: ModelToolUse,
  definitions: readonly ModelToolDefinition[],
  hasFailedToolResult: boolean,
): { readonly message?: ModelMessage; readonly segments: readonly ContextSegment[] } {
  const promptGroups = SYSTEM_SLOT_IDS.map((slot) => ({
    slot,
    prompts: promptsForSlot(prompts, slot, toolUse, hasFailedToolResult),
  }));
  const promptContents = promptGroups
    .flatMap(({ prompts: slotPrompts }) => slotPrompts.map((prompt) => prompt.content))
    .filter((value) => value.length > 0);
  const promptedDefinitions =
    toolUse === 'prompted' ? formatPromptedToolDefinitions(definitions) : undefined;
  const content = [
    ...promptContents,
    ...(promptedDefinitions === undefined ? [] : [promptedDefinitions]),
  ]
    .filter((value) => value.length > 0)
    .join('\n\n');
  if (content.length === 0) {
    return { segments: [] };
  }
  const segments = [
    ...promptGroups.flatMap(({ slot, prompts: slotPrompts }) =>
      slotPrompts.flatMap((prompt) => promptSegments(slot, prompt)),
    ),
    ...(promptedDefinitions === undefined
      ? []
      : [
          {
            id: 'slot:tool-protocol:definitions',
            stage: 'slots' as const,
            role: 'system' as const,
            content: promptedDefinitions,
            source: { kind: 'tool' as const, id: 'definitions' },
            tokenCount: null,
            messageIndex: 0,
          },
        ]),
  ];
  return { message: { role: 'system', content }, segments };
}

function formatPromptedToolDefinitions(definitions: readonly ModelToolDefinition[]): string {
  return [
    'Available tools (one JSON object per line):',
    ...definitions.map((definition) =>
      JSON.stringify({
        name: definition.name,
        ...(definition.description === undefined ? {} : { description: definition.description }),
        inputSchema: definition.inputSchema,
      }),
    ),
  ].join('\n');
}

function promptsForSlot(
  prompts: PromptRegistrySnapshot,
  slot: SystemSlotId,
  toolUse: ModelToolUse,
  hasFailedToolResult: boolean,
): readonly Prompt[] {
  const selected = [prompts.require(`system.${slot}`)];
  if (slot === 'tool-protocol' && toolUse === 'prompted') {
    selected.push(prompts.require('tool.protocol.prompted'));
  }
  if (slot === 'tool-protocol' && hasFailedToolResult) {
    selected.push(prompts.require('error.retry-hint'));
  }
  return selected;
}

function promptSegments(slot: SystemSlotId, prompt: Prompt): readonly ContextSegment[] {
  return prompt.parts.flatMap((part, index) =>
    part.content.length === 0
      ? []
      : [
          {
            id: `slot:${slot}:${prompt.id}:${index}`,
            stage: 'slots' as const,
            role: 'system' as const,
            content: part.content,
            source: {
              kind: 'prompt' as const,
              id: part.source.id,
              promptId: prompt.id,
              promptSource: part.source.kind,
              sourceVersion: part.sourceVersion,
              version: part.version,
              mode: part.mode,
            },
            tokenCount: null,
            messageIndex: 0,
          },
        ],
  );
}

function stageSnapshot(
  stage: ContextStageId,
  status: 'applied' | 'noop',
  messages: readonly ModelMessage[],
  segments: readonly ContextSegment[],
): ContextStageSnapshot {
  return {
    stage,
    status,
    messages: messages.map(messageToAssembly),
    segmentIds: segments.map((segment) => segment.id),
    tokenCount: null,
  };
}

function reconcileMessageSegments(
  previousMessages: readonly ModelMessage[],
  previousSegments: readonly ContextSegment[],
  nextMessages: readonly ModelMessage[],
  stage: ContextStageId,
  source: ContextSegmentSource,
): ContextSegment[] {
  const matches = longestCommonSubsequence(previousMessages, nextMessages);
  const previousByNext = new Map(
    matches.map(([previousIndex, nextIndex]) => [nextIndex, previousIndex]),
  );
  const reconciled: ContextSegment[] = [];
  nextMessages.forEach((message, nextIndex) => {
    const previousIndex = previousByNext.get(nextIndex);
    if (previousIndex !== undefined) {
      reconciled.push(
        ...previousSegments
          .filter((segment) => segment.messageIndex === previousIndex)
          .map((segment) => ({ ...structuredClone(segment), messageIndex: nextIndex })),
      );
      return;
    }
    reconciled.push({
      id: `${stage}:${nextIndex}`,
      stage,
      role: message.role,
      content: message.content,
      source: structuredClone(source),
      tokenCount: null,
      messageIndex: nextIndex,
    });
  });
  return reconciled;
}

function longestCommonSubsequence(
  left: readonly ModelMessage[],
  right: readonly ModelMessage[],
): readonly (readonly [number, number])[] {
  const lengths = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      const row = lengths[leftIndex];
      const nextRow = lengths[leftIndex + 1];
      if (row === undefined || nextRow === undefined) {
        continue;
      }
      row[rightIndex] = jsonEqual(left[leftIndex], right[rightIndex])
        ? 1 + (nextRow[rightIndex + 1] ?? 0)
        : Math.max(nextRow[rightIndex] ?? 0, row[rightIndex + 1] ?? 0);
    }
  }
  const matches: Array<readonly [number, number]> = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (jsonEqual(left[leftIndex], right[rightIndex])) {
      matches.push([leftIndex, rightIndex]);
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    const down = lengths[leftIndex + 1]?.[rightIndex] ?? 0;
    const across = lengths[leftIndex]?.[rightIndex + 1] ?? 0;
    if (down >= across) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return matches;
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
    const toolCalls = jsonToModelToolCalls(item['toolCalls']);
    if (
      (name !== undefined && typeof name !== 'string') ||
      (toolCallId !== undefined && typeof toolCallId !== 'string') ||
      (item['toolCalls'] !== undefined && toolCalls === undefined) ||
      (toolCalls !== undefined && role !== 'assistant')
    ) {
      return undefined;
    }
    messages.push({
      role,
      content,
      ...(name === undefined ? {} : { name }),
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
    });
  }
  return messages;
}

function jsonToModelToolCalls(value: JsonValue | undefined): ModelMessageToolCall[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const calls: ModelMessageToolCall[] = [];
  for (const item of value) {
    if (!isJsonObject(item)) {
      return undefined;
    }
    const callId = item['callId'];
    const tool = item['tool'];
    const args = item['args'];
    if (
      typeof callId !== 'string' ||
      callId.length === 0 ||
      typeof tool !== 'string' ||
      tool.length === 0 ||
      !isJsonValue(args)
    ) {
      return undefined;
    }
    calls.push({ callId, tool, args: structuredClone(args) });
  }
  return calls;
}

function jsonToModelTools(value: JsonValue | undefined): ModelToolDefinition[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tools: ModelToolDefinition[] = [];
  for (const item of value) {
    if (!isJsonObject(item)) {
      return undefined;
    }
    const name = item['name'];
    const description = item['description'];
    const inputSchema = item['inputSchema'];
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      (description !== undefined && typeof description !== 'string') ||
      !isJsonObject(inputSchema)
    ) {
      return undefined;
    }
    tools.push({
      name,
      ...(description === undefined ? {} : { description }),
      inputSchema: structuredClone(inputSchema),
    });
  }
  return tools;
}

function messageToAssembly(message: ModelMessage): ContextAssemblyMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.toolCalls === undefined
      ? {}
      : {
          toolCalls: message.toolCalls.map((call) => ({
            callId: call.callId,
            tool: call.tool,
            args: structuredClone(call.args),
          })),
        }),
  };
}

function toolToAssembly(tool: ModelToolDefinition) {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: structuredClone(tool.inputSchema),
  };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.values(value).every((item) => item !== undefined && isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function toolDefinition(tool: Tool): ModelToolDefinition {
  const description = tool.permission.description;
  return {
    name: tool.name,
    ...(description === undefined ? {} : { description }),
    inputSchema: structuredClone(tool.inputSchema),
  };
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  const leftObject = left as Record<string, unknown>;
  const rightObject = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => rightKeys[index] === key && jsonEqual(leftObject[key], rightObject[key]),
    )
  );
}

function formatTokenCount(value: number | null): string {
  return value === null ? 'unmeasured' : String(value);
}

function formatSource(source: ContextSegmentSource): string {
  switch (source.kind) {
    case 'prompt':
      return `${source.promptId ?? 'prompt'} from ${source.promptSource ?? 'unknown'}/${source.id ?? 'unknown'}@${source.sourceVersion ?? 'unknown'} (${source.mode ?? 'replace'}, prompt ${source.version ?? 'unknown'})`;
    case 'event':
      return `${source.id ?? source.kind} seq=${source.sourceSeqs?.join(',') ?? 'none'}`;
    case 'compaction':
      return `${source.id ?? source.kind} from ${source.strategy ?? 'unknown strategy'} seq=${source.sourceSeqs?.join(',') ?? 'none'}`;
    case 'middleware':
      return `${source.middlewareKind ?? 'unknown'} middleware`;
    default:
      return source.id === undefined ? source.kind : `${source.kind}/${source.id}`;
  }
}
