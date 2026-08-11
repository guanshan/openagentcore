import { isDeepStrictEqual } from 'node:util';
import { env } from 'node:process';

import {
  EchoTool,
  type AgentEvent,
  type ModelCapabilities,
  type ModelPort,
} from '@openagentcore/kernel';
import { AgentBuilder } from '@openagentcore/standard';
import {
  OpenAICompatibleModel,
  RecordingModelPort,
  ReplayModelPort,
} from '@openagentcore/standard/model';

if (env['OAC_RUN_LIVE'] !== '1') {
  throw new Error('Live model access requires the explicit OAC_RUN_LIVE=1 gate.');
}

const toolUse = liveToolUse(env['OAC_MODEL_TOOL_USE']);
const provider = new OpenAICompatibleModel({
  baseUrl: env['OAC_MODEL_BASE_URL'] ?? 'http://127.0.0.1:11434/v1',
  model: requiredEnvironment('OAC_MODEL_NAME'),
  capabilities: {
    maxContext: positiveEnvironment('OAC_MODEL_MAX_CONTEXT'),
    toolUse,
  },
  ...(env['OAC_MODEL_API_KEY'] === undefined ? {} : { apiKey: env['OAC_MODEL_API_KEY'] }),
});
const recorder = new RecordingModelPort(provider);
const input = {
  content: 'Call echo exactly once with {"text":"recorded ping"}, then report completion.',
} as const;

const original = await createLiveAgent(recorder).runTurn(input);
const recording = recorder.snapshot();
const replay = new ReplayModelPort(recording);
const replayed = await createLiveAgent(replay).runTurn(input);
replay.assertExhausted();

if (!isDeepStrictEqual(withoutTimestamps(replayed.events), withoutTimestamps(original.events))) {
  throw new Error('Replay event stream differs from the recorded live turn.');
}
if (!original.events.some((event) => event.type === 'tool.result')) {
  throw new Error('The live endpoint did not complete the required tool call.');
}

console.error(
  `Live ${toolUse} turn and deterministic replay completed with ${original.events.length} events.`,
);
console.log(JSON.stringify(recording, null, 2));

function createLiveAgent(model: ModelPort) {
  return AgentBuilder.fromPreset('oss-local')
    .environment({})
    .model(model)
    .tool(new EchoTool())
    .build();
}

function withoutTimestamps(events: readonly AgentEvent[]): unknown[] {
  return events.map(({ ts, ...event }) => {
    void ts;
    return event;
  });
}

function requiredEnvironment(name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function positiveEnvironment(name: string): number {
  const value = requiredEnvironment(name);
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe positive integer.`);
  }
  return parsed;
}

function liveToolUse(value: string | undefined): ModelCapabilities['toolUse'] {
  const selected = value ?? 'native';
  if (selected !== 'native' && selected !== 'prompted') {
    throw new Error('OAC_MODEL_TOOL_USE must be native or prompted for the live tool turn.');
  }
  return selected;
}
