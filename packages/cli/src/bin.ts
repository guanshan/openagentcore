#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  createConformanceReport,
  defaultModelAdapters,
  defaultSandboxAdapters,
  defaultStoreAdapters,
  defaultTraceAdapters,
  formatCapabilityMatrix,
  formatHumanReport,
  runModelConformance,
  runSandboxConformance,
  runStoreConformance,
  runTraceConformance,
} from './conformance/index.js';

const options = parseArgs(process.argv.slice(2));
const suites = [];
for (const adapter of defaultModelAdapters()) {
  suites.push(await runModelConformance(adapter));
}
for (const adapter of defaultSandboxAdapters()) {
  suites.push(await runSandboxConformance(adapter));
}
for (const adapter of defaultStoreAdapters()) {
  suites.push(await runStoreConformance(adapter));
}
for (const adapter of defaultTraceAdapters()) {
  suites.push(await runTraceConformance(adapter));
}
const report = createConformanceReport(suites);

if (options.jsonPath !== undefined) {
  await writeGenerated(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
}
if (options.matrixPath !== undefined) {
  await writeGenerated(options.matrixPath, formatCapabilityMatrix(report));
}
process.stdout.write(
  options.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : formatHumanReport(report),
);
if (report.status === 'failed') {
  process.exitCode = 1;
}

interface CliOptions {
  readonly format: 'human' | 'json';
  readonly jsonPath?: string;
  readonly matrixPath?: string;
}

function parseArgs(args: readonly string[]): CliOptions {
  if (args[0] !== 'conformance') {
    usage('Expected the conformance subcommand.');
  }
  let format: CliOptions['format'] = 'human';
  let jsonPath: string | undefined;
  let matrixPath: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--format') {
      const value = args[index + 1];
      if (value !== 'human' && value !== 'json') {
        usage('--format must be human or json.');
      }
      format = value;
      index += 1;
    } else if (argument === '--json') {
      jsonPath = requiredValue(args, ++index, '--json');
    } else if (argument === '--matrix') {
      matrixPath = requiredValue(args, ++index, '--matrix');
    } else {
      usage(`Unknown argument: ${String(argument)}.`);
    }
  }
  return {
    format,
    ...(jsonPath === undefined ? {} : { jsonPath }),
    ...(matrixPath === undefined ? {} : { matrixPath }),
  };
}

function requiredValue(args: readonly string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) {
    usage(`${option} requires a path.`);
  }
  return value;
}

function usage(error: string): never {
  throw new Error(
    `${error}\nUsage: oac conformance [--format human|json] [--json path] [--matrix path]`,
  );
}

async function writeGenerated(path: string, content: string): Promise<void> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, 'utf8');
}
