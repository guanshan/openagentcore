export const PROMPT_SOURCE_KINDS = ['builtin', 'directory', 'runtime'] as const;

export type PromptSourceKind = (typeof PROMPT_SOURCE_KINDS)[number];

export type PromptOverrideMode = 'replace' | 'append';

export interface PromptSourceRef {
  readonly kind: PromptSourceKind;
  readonly id: string;
}

export interface PromptDefinition {
  readonly id: string;
  readonly content: string;
  readonly version?: string;
  readonly mode?: PromptOverrideMode;
}

export interface PromptSourceSnapshot {
  readonly id?: string;
  readonly version: string;
  readonly prompts: readonly PromptDefinition[];
}

export interface PromptSourceInfo extends PromptSourceRef {
  readonly version: string;
  readonly promptCount: number;
}

export interface PromptContribution {
  readonly source: PromptSourceRef;
  readonly sourceVersion: string;
  readonly version: string;
  readonly mode: PromptOverrideMode;
  readonly content: string;
}

export interface Prompt {
  readonly id: string;
  readonly content: string;
  readonly source: PromptSourceRef;
  readonly sourceVersion: string;
  readonly version: string;
  readonly mode: PromptOverrideMode;
  readonly parts: readonly PromptContribution[];
}

export interface PromptRegistrySnapshot {
  readonly revision: number;
  get(id: string): Prompt | undefined;
  require(id: string): Prompt;
  list(): readonly Prompt[];
  listSources(): readonly PromptSourceInfo[];
  sourceVersion(source: PromptSourceKind): string | undefined;
}

export class PromptRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptRegistryError';
  }
}

interface NormalizedPromptDefinition {
  readonly id: string;
  readonly content: string;
  readonly version: string;
  readonly mode: PromptOverrideMode;
}

interface NormalizedPromptSource {
  readonly source: PromptSourceRef;
  readonly version: string;
  readonly prompts: ReadonlyMap<string, NormalizedPromptDefinition>;
}

interface RegistryState {
  readonly revision: number;
  readonly sources: ReadonlyMap<PromptSourceKind, NormalizedPromptSource>;
  readonly prompts: ReadonlyMap<string, Prompt>;
  readonly promptList: readonly Prompt[];
  readonly sourceList: readonly PromptSourceInfo[];
}

const EMPTY_STATE: RegistryState = {
  revision: 0,
  sources: new Map(),
  prompts: new Map(),
  promptList: Object.freeze([]),
  sourceList: Object.freeze([]),
};

export class PromptRegistry implements PromptRegistrySnapshot {
  #state: RegistryState = EMPTY_STATE;

  constructor(builtin?: PromptSourceSnapshot) {
    if (builtin !== undefined) {
      this.replaceSource('builtin', builtin);
    }
  }

  get revision(): number {
    return this.#state.revision;
  }

  get(id: string): Prompt | undefined {
    return this.#state.prompts.get(id);
  }

  require(id: string): Prompt {
    return requirePrompt(this.#state, id);
  }

  list(): readonly Prompt[] {
    return this.#state.promptList;
  }

  listSources(): readonly PromptSourceInfo[] {
    return this.#state.sourceList;
  }

  sourceVersion(source: PromptSourceKind): string | undefined {
    return this.#state.sources.get(source)?.version;
  }

  snapshot(): PromptRegistrySnapshot {
    return new FixedPromptRegistrySnapshot(this.#state);
  }

  replaceSource(source: PromptSourceKind, snapshot: PromptSourceSnapshot): this {
    const normalized = normalizeSource(source, snapshot);
    const sources = new Map(this.#state.sources);
    sources.set(source, normalized);
    this.#state = buildState(nextRevision(this.#state.revision), sources);
    return this;
  }

  replace(id: string, content: string, version = 'runtime'): this {
    return this.#setRuntimePrompt({ id, content, version, mode: 'replace' });
  }

  append(id: string, content: string, version = 'runtime'): this {
    return this.#setRuntimePrompt({ id, content, version, mode: 'append' });
  }

  replaceRuntime(id: string, content: string, version = 'runtime'): this {
    return this.replace(id, content, version);
  }

  appendRuntime(id: string, content: string, version = 'runtime'): this {
    return this.append(id, content, version);
  }

  deleteRuntime(id: string, version = 'runtime'): boolean {
    const current = this.#state.sources.get('runtime');
    if (current === undefined || !current.prompts.has(id)) {
      return false;
    }
    validateVersion(version, 'Runtime source version');
    const prompts = [...current.prompts.values()].filter((prompt) => prompt.id !== id);
    this.replaceSource('runtime', {
      id: current.source.id,
      version,
      prompts,
    });
    return true;
  }

  #setRuntimePrompt(prompt: NormalizedPromptDefinition): this {
    const current = this.#state.sources.get('runtime');
    const prompts = new Map(current?.prompts);
    prompts.set(prompt.id, prompt);
    return this.replaceSource('runtime', {
      id: current?.source.id ?? 'runtime',
      version: prompt.version,
      prompts: [...prompts.values()],
    });
  }
}

class FixedPromptRegistrySnapshot implements PromptRegistrySnapshot {
  readonly #state: RegistryState;

  constructor(state: RegistryState) {
    this.#state = state;
  }

  get revision(): number {
    return this.#state.revision;
  }

  get(id: string): Prompt | undefined {
    return this.#state.prompts.get(id);
  }

  require(id: string): Prompt {
    return requirePrompt(this.#state, id);
  }

  list(): readonly Prompt[] {
    return this.#state.promptList;
  }

  listSources(): readonly PromptSourceInfo[] {
    return this.#state.sourceList;
  }

  sourceVersion(source: PromptSourceKind): string | undefined {
    return this.#state.sources.get(source)?.version;
  }
}

function normalizeSource(
  kind: PromptSourceKind,
  snapshot: PromptSourceSnapshot,
): NormalizedPromptSource {
  if (!PROMPT_SOURCE_KINDS.includes(kind)) {
    throw new PromptRegistryError(`Unknown prompt source kind: ${String(kind)}.`);
  }
  validateVersion(snapshot.version, `Prompt source ${kind} version`);
  const sourceId = snapshot.id ?? kind;
  validateNonEmpty(sourceId, `Prompt source ${kind} id`);

  const prompts = new Map<string, NormalizedPromptDefinition>();
  for (const candidate of snapshot.prompts) {
    validateNonEmpty(candidate.id, 'Prompt id');
    if (typeof candidate.content !== 'string') {
      throw new PromptRegistryError(`Prompt ${candidate.id} content must be a string.`);
    }
    const version = candidate.version ?? snapshot.version;
    validateVersion(version, `Prompt ${candidate.id} version`);
    const mode = candidate.mode ?? 'replace';
    if (mode !== 'replace' && mode !== 'append') {
      throw new PromptRegistryError(
        `Prompt ${candidate.id} has unsupported override mode: ${String(mode)}.`,
      );
    }
    if (prompts.has(candidate.id)) {
      throw new PromptRegistryError(
        `Prompt source ${kind}/${sourceId} contains duplicate id: ${candidate.id}.`,
      );
    }
    prompts.set(
      candidate.id,
      Object.freeze({
        id: candidate.id,
        content: candidate.content,
        version,
        mode,
      }),
    );
  }

  return {
    source: Object.freeze({ kind, id: sourceId }),
    version: snapshot.version,
    prompts,
  };
}

function buildState(
  revision: number,
  sources: ReadonlyMap<PromptSourceKind, NormalizedPromptSource>,
): RegistryState {
  const promptIds = new Set<string>();
  for (const source of sources.values()) {
    for (const id of source.prompts.keys()) {
      promptIds.add(id);
    }
  }

  const prompts = new Map<string, Prompt>();
  for (const id of [...promptIds].sort(compareStrings)) {
    const prompt = resolvePrompt(id, sources);
    if (prompt !== undefined) {
      prompts.set(id, prompt);
    }
  }

  const sourceList = PROMPT_SOURCE_KINDS.flatMap((kind) => {
    const source = sources.get(kind);
    return source === undefined
      ? []
      : [
          Object.freeze({
            ...source.source,
            version: source.version,
            promptCount: source.prompts.size,
          }),
        ];
  });

  return {
    revision,
    sources,
    prompts,
    promptList: Object.freeze([...prompts.values()]),
    sourceList: Object.freeze(sourceList),
  };
}

function resolvePrompt(
  id: string,
  sources: ReadonlyMap<PromptSourceKind, NormalizedPromptSource>,
): Prompt | undefined {
  let content = '';
  let parts: readonly PromptContribution[] = [];
  let effective: PromptContribution | undefined;

  for (const kind of PROMPT_SOURCE_KINDS) {
    const source = sources.get(kind);
    const prompt = source?.prompts.get(id);
    if (source === undefined || prompt === undefined) {
      continue;
    }
    const contribution: PromptContribution = Object.freeze({
      source: source.source,
      sourceVersion: source.version,
      version: prompt.version,
      mode: prompt.mode,
      content: prompt.content,
    });
    if (prompt.mode === 'replace') {
      content = prompt.content;
      parts = [contribution];
    } else {
      content = appendContent(content, prompt.content);
      parts = [...parts, contribution];
    }
    effective = contribution;
  }

  if (effective === undefined) {
    return undefined;
  }
  const frozenParts = Object.freeze(parts);
  return Object.freeze({
    id,
    content,
    source: effective.source,
    sourceVersion: effective.sourceVersion,
    version: effective.version,
    mode: effective.mode,
    parts: frozenParts,
  });
}

function appendContent(base: string, addition: string): string {
  if (base.length === 0) {
    return addition;
  }
  if (addition.length === 0) {
    return base;
  }
  return `${base}\n${addition}`;
}

function requirePrompt(state: RegistryState, id: string): Prompt {
  const prompt = state.prompts.get(id);
  if (prompt === undefined) {
    throw new PromptRegistryError(`Prompt not registered: ${id}.`);
  }
  return prompt;
}

function nextRevision(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) {
    throw new PromptRegistryError('Prompt registry revision is exhausted.');
  }
  return current + 1;
}

function validateVersion(version: string, label: string): void {
  validateNonEmpty(version, label);
}

function validateNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PromptRegistryError(`${label} must be a non-empty string.`);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
