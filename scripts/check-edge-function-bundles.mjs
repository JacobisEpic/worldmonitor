#!/usr/bin/env node

/**
 * Browser-bundle the API entrypoints that can actually ship in a commit.
 *
 * Git's tracked inventory is the deployment contract. Real Vercel functions
 * must be tracked to reach CI or production, while ignored desktop sidecar
 * bundles are local Node artifacts and must not be treated as edge functions.
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const GIT_LOCAL_ENV_VARS = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');

function isolatedGitEnv() {
  const env = { ...process.env };
  for (const name of GIT_LOCAL_ENV_VARS) delete env[name];
  return env;
}

function listTrackedApiFiles(root) {
  return execFileSync('git', ['-C', root, 'ls-files', '-z', '--', 'api'], {
    encoding: 'utf8',
    env: isolatedGitEnv(),
  })
    .split('\0')
    .filter(Boolean)
    .sort();
}

export function listTrackedApiSourceFiles(root = process.cwd()) {
  return listTrackedApiFiles(root).filter((file) => {
    const apiParts = file.split('/').slice(1);
    return !apiParts.some((part) => part.startsWith('_'))
      && (file.endsWith('.js') || file.endsWith('.ts'));
  });
}

export function listEdgeFunctionEntries(root = process.cwd()) {
  return listTrackedApiFiles(root).filter((file) => {
    const basename = path.posix.basename(file);
    if (basename.startsWith('_') || basename.includes('.test.')) return false;
    if (file.endsWith('.js')) return true;
    // Preserve the pre-push contract for TS entries. Nested TS gateways are
    // checked through their importing top-level entrypoints and API typecheck.
    return file.endsWith('.ts') && path.posix.dirname(file) === 'api';
  });
}

export async function checkEdgeFunctionBundles({ root = process.cwd() } = {}) {
  const entries = listEdgeFunctionEntries(root);
  if (entries.length === 0) {
    throw new Error('edge function bundle check found zero tracked entrypoints');
  }

  const outdir = await mkdtemp(path.join(os.tmpdir(), 'worldmonitor-edge-bundles-'));
  try {
    await build({
      absWorkingDir: root,
      entryPoints: entries.map((file) => ({
        in: file,
        out: `${file.slice(0, -path.posix.extname(file).length)}-${path.posix.extname(file).slice(1)}`,
      })),
      outdir,
      bundle: true,
      format: 'esm',
      platform: 'browser',
      logLevel: 'error',
    });
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }

  return entries;
}

async function main() {
  const entries = process.argv.includes('--list')
    ? listEdgeFunctionEntries()
    : await checkEdgeFunctionBundles();

  if (process.argv.includes('--list')) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
  } else {
    console.log(`edge function bundles ok: ${entries.length} tracked entrypoints`);
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(`edge function bundle check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
