import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import {
  checkEdgeFunctionBundles,
  listEdgeFunctionEntries,
} from '../scripts/check-edge-function-bundles.mjs';

const GIT_LOCAL_ENV_VARS = execFileSync('git', ['rev-parse', '--local-env-vars'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n');

function isolatedGitEnv() {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  for (const name of GIT_LOCAL_ENV_VARS) delete env[name];
  return env;
}

const fixtures = [];
after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    env: isolatedGitEnv(),
    encoding: 'utf8',
  });
}

function write(root, relativePath, contents) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function makeRepo({ withEntries = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wm-edge-function-bundles-'));
  fixtures.push(root);
  git(root, ['init', '--quiet', '--initial-branch=main', '.']);

  if (!withEntries) {
    write(root, 'README.md', 'no API entries\n');
    git(root, ['add', 'README.md']);
    return root;
  }

  const validHandler = 'export default async function handler() { return new Response("ok"); }\n';
  write(root, '.gitignore', 'api/*/v1/\\[rpc\\].js\n');
  write(root, 'api/health.js', validHandler);
  write(root, 'api/normal.js', validHandler);
  write(root, 'api/paired.js', validHandler);
  write(root, 'api/paired.ts', validHandler);
  write(root, 'api/space route.js', validHandler);
  write(root, 'api/mcp.ts', validHandler);
  write(root, 'api/_helper.js', 'export const helper = true;\n');
  write(root, 'api/domain/v1/[rpc].ts', validHandler);
  write(root, 'api/domain/v1/[rpc].js', 'import "node:crypto";\n');
  write(root, 'api/stale/v1/[rpc].js', 'import "node:crypto";\n');
  write(root, 'api/v2/shipping/[rpc].js', validHandler);
  git(root, ['add', '-A']);

  assert.doesNotThrow(() => git(root, ['check-ignore', '--quiet', 'api/domain/v1/[rpc].js']));
  assert.doesNotThrow(() => git(root, ['check-ignore', '--quiet', 'api/stale/v1/[rpc].js']));
  return root;
}

describe('edge function candidate discovery', () => {
  test('selects tracked edge entries without local generated sidecar residue', () => {
    const root = makeRepo();
    assert.deepEqual(listEdgeFunctionEntries(root), [
      'api/health.js',
      'api/mcp.ts',
      'api/normal.js',
      'api/paired.js',
      'api/paired.ts',
      'api/space route.js',
      'api/v2/shipping/[rpc].js',
    ]);
  });

  test('the real checker ignores sidecar residue but still bundles tracked entries', async () => {
    const root = makeRepo();
    const entries = await checkEdgeFunctionBundles({ root });
    assert.ok(entries.includes('api/health.js'));
    assert.ok(!entries.includes('api/domain/v1/[rpc].js'));
  });

  test('fails closed when no tracked edge entries exist', async () => {
    const root = makeRepo({ withEntries: false });
    await assert.rejects(
      checkEdgeFunctionBundles({ root }),
      /found zero tracked entrypoints/,
    );
  });

  test('still fails on a browser-incompatible tracked edge entry', async () => {
    const root = makeRepo();
    write(root, 'api/broken.js', 'import "node:crypto";\n');
    git(root, ['add', 'api/broken.js']);
    await assert.rejects(
      checkEdgeFunctionBundles({ root }),
      /Could not resolve "node:crypto"/,
    );
  });
});
