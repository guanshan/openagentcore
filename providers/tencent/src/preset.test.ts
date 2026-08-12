import {
  NoopTracer,
  ScriptedModelPort,
  UnavailableVault,
  type SandboxPort,
} from '@openagentcore/kernel';
import { describe, expect, it } from 'vitest';

import { TencentAgentBuilder, TencentPresetConfigError } from './preset.js';

describe('TencentAgentBuilder', () => {
  it('supports replacing one Tencent preset Port with another provider family', () => {
    const presetModel = new ScriptedModelPort([]);
    const replacementModel = new ScriptedModelPort([]);
    const sandbox = inertSandbox();
    const trace = new NoopTracer();
    const vault = new UnavailableVault();

    const loop = TencentAgentBuilder.fromPreset('tencent-full', {
      environment: {},
      adapters: { model: presetModel, sandbox, trace, vault },
    })
      .model(replacementModel)
      .build();

    expect(loop.model).toBe(replacementModel);
    expect(loop.sandbox).toBe(sandbox);
    expect(loop.trace).toBe(trace);
    expect(loop.vault).toBe(vault);
  });

  it('fails closed when required live configuration is absent', () => {
    expect(() => TencentAgentBuilder.fromPreset('tencent-full', { environment: {} })).toThrow(
      TencentPresetConfigError,
    );
  });
});

function inertSandbox(): SandboxPort {
  return {
    capabilities: { snapshot: false },
    workspacePath: '/workspace',
    fs: {
      readFile: async () => new Uint8Array(),
      writeFile: async () => {},
      realpath: async (path) => path,
    },
    exec: async (request) => ({
      command: request.command,
      stdout: '',
      stderr: '',
      exitCode: 0,
      signal: null,
      outputTruncated: false,
    }),
  };
}
