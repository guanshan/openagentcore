import { describe, expect, it } from 'vitest';

import { BUILTIN_PROMPTS, BUILTIN_PROMPT_SOURCE, createDefaultPromptRegistry } from './builtins.js';
import { PromptRegistryError } from './registry.js';

describe('PromptRegistry', () => {
  it('enumerates every versioned builtin in stable id order', () => {
    const prompts = createDefaultPromptRegistry();
    const listed = prompts.list();

    expect(listed).toHaveLength(BUILTIN_PROMPTS.length);
    expect(listed.length).toBeGreaterThanOrEqual(9);
    expect(listed.map((prompt) => prompt.id)).toEqual(
      BUILTIN_PROMPTS.map((prompt) => prompt.id).sort(),
    );
    expect(listed.find((prompt) => prompt.id === 'tool.protocol.prompted')?.version).toBe('1.1.0');
    expect(
      listed
        .filter((prompt) => prompt.id !== 'tool.protocol.prompted')
        .every((prompt) => prompt.version === '1.0.0'),
    ).toBe(true);
    expect(prompts.get('system.identity')).toBe(prompts.require('system.identity'));
    expect(prompts.get('missing')).toBeUndefined();
    expect(() => prompts.require('missing')).toThrow(PromptRegistryError);
    expect(prompts.list()).toBe(listed);
    expect(prompts.listSources()).toEqual([
      {
        kind: 'builtin',
        id: '@openagentcore/kernel',
        version: '1.1.0',
        promptCount: BUILTIN_PROMPTS.length,
      },
    ]);
  });

  it('resolves builtin, directory, and runtime sources in precedence order', () => {
    const prompts = createDefaultPromptRegistry()
      .replaceSource('directory', {
        id: '/workspace/.openagentcore/prompts',
        version: 'directory-1',
        prompts: [
          {
            id: 'system.identity',
            version: 'identity-directory-1',
            mode: 'replace',
            content: 'Directory identity.',
          },
          {
            id: 'system.capabilities',
            mode: 'append',
            content: 'Directory capability.',
          },
        ],
      })
      .append('system.identity', 'Runtime identity suffix.', 'runtime-1')
      .replace('system.capabilities', 'Runtime capabilities.', 'runtime-2');

    expect(prompts.require('system.identity')).toMatchObject({
      content: 'Directory identity.\nRuntime identity suffix.',
      source: { kind: 'runtime', id: 'runtime' },
      sourceVersion: 'runtime-2',
      version: 'runtime-1',
      mode: 'append',
    });
    expect(prompts.require('system.identity').parts).toEqual([
      {
        source: { kind: 'directory', id: '/workspace/.openagentcore/prompts' },
        sourceVersion: 'directory-1',
        version: 'identity-directory-1',
        mode: 'replace',
        content: 'Directory identity.',
      },
      {
        source: { kind: 'runtime', id: 'runtime' },
        sourceVersion: 'runtime-2',
        version: 'runtime-1',
        mode: 'append',
        content: 'Runtime identity suffix.',
      },
    ]);
    expect(prompts.require('system.capabilities')).toMatchObject({
      content: 'Runtime capabilities.',
      source: { kind: 'runtime', id: 'runtime' },
      version: 'runtime-2',
      mode: 'replace',
    });
  });

  it('atomically replaces a source and advances a monotonic revision', () => {
    const prompts = createDefaultPromptRegistry().replaceSource('directory', {
      id: 'project-prompts',
      version: 'directory-1',
      prompts: [{ id: 'project.one', content: 'One.' }],
    });
    const beforeRevision = prompts.revision;
    const beforeList = prompts.list();

    expect(() =>
      prompts.replaceSource('directory', {
        id: 'broken-project-prompts',
        version: 'directory-2',
        prompts: [
          { id: 'duplicate', content: 'First.' },
          { id: 'duplicate', content: 'Second.' },
        ],
      }),
    ).toThrow(PromptRegistryError);
    expect(prompts.revision).toBe(beforeRevision);
    expect(prompts.list()).toBe(beforeList);
    expect(prompts.require('project.one').content).toBe('One.');

    prompts.replaceSource('directory', {
      id: 'project-prompts',
      version: 'directory-3',
      prompts: [{ id: 'project.two', content: 'Two.' }],
    });
    expect(prompts.revision).toBe(beforeRevision + 1);
    expect(prompts.get('project.one')).toBeUndefined();
    expect(prompts.require('project.two').content).toBe('Two.');
    expect(prompts.sourceVersion('directory')).toBe('directory-3');
  });

  it('keeps a fixed assembly snapshot while the live registry hot-updates', () => {
    const prompts = createDefaultPromptRegistry();
    const assemblyView = prompts.snapshot();
    const capturedRevision = assemblyView.revision;

    prompts.replace('system.identity', 'Runtime identity.', 'runtime-1');

    expect(prompts.revision).toBe(capturedRevision + 1);
    expect(prompts.require('system.identity').content).toBe('Runtime identity.');
    expect(assemblyView.revision).toBe(capturedRevision);
    expect(assemblyView.require('system.identity').content).toBe(
      BUILTIN_PROMPTS.find((prompt) => prompt.id === 'system.identity')?.content,
    );
  });

  it('updates individual runtime prompts with replace and append without dropping siblings', () => {
    const prompts = createDefaultPromptRegistry()
      .replaceRuntime('system.identity', 'Custom identity.', 'runtime-1')
      .appendRuntime('system.capabilities', 'Custom capability.', 'runtime-2');

    expect(prompts.require('system.identity').content).toBe('Custom identity.');
    expect(prompts.require('system.capabilities').content).toContain('Custom capability.');
    expect(prompts.deleteRuntime('system.identity', 'runtime-3')).toBe(true);
    expect(prompts.require('system.identity').source.kind).toBe('builtin');
    expect(prompts.require('system.capabilities').content).toContain('Custom capability.');
    expect(prompts.deleteRuntime('system.identity', 'runtime-4')).toBe(false);
  });

  it('preserves custom replace and append layers across an SDK builtin upgrade', () => {
    const prompts = createDefaultPromptRegistry()
      .replace('system.identity', 'Custom identity.', 'runtime-identity-1')
      .append('system.capabilities', 'Custom capability.', 'runtime-capability-1');
    const upgradedPrompts = BUILTIN_PROMPT_SOURCE.prompts.map((prompt) =>
      prompt.id === 'system.capabilities'
        ? { ...prompt, version: '2.0.0', content: 'SDK v2 capabilities.' }
        : { ...prompt, version: '2.0.0' },
    );

    prompts.replaceSource('builtin', {
      id: '@openagentcore/kernel',
      version: '2.0.0',
      prompts: upgradedPrompts,
    });

    expect(prompts.require('system.identity').content).toBe('Custom identity.');
    expect(prompts.require('system.identity').version).toBe('runtime-identity-1');
    expect(prompts.require('system.capabilities').content).toBe(
      'SDK v2 capabilities.\nCustom capability.',
    );
    expect(prompts.require('system.capabilities').parts.map((part) => part.source.kind)).toEqual([
      'builtin',
      'runtime',
    ]);
  });
});
