import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import hook from './build-hook.cjs';

test('build hooks run inside the source checkout and propagate failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'suvio-build-hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'prepare.sh'), 'printf prepared > result.txt\n');
  hook.runBuildHook(root, 'prepare.sh');
  assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'prepared');
  await writeFile(join(root, 'verify.sh'), 'exit 7\n');
  assert.throws(() => hook.runBuildHook(root, 'verify.sh'), /failed/);
});

test('build hooks reject traversal, shell expressions and escaping symlinks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'suvio-build-hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'source'));
  await writeFile(join(root, 'outside.sh'), 'exit 0\n');
  await symlink('../outside.sh', join(root, 'source', 'linked.sh'));
  for (const path of ['../outside.sh', '/tmp/outside.sh', 'prepare.sh;exit 0', '$(echo x).sh', 'linked.sh'])
    assert.throws(() => hook.runBuildHook(join(root, 'source'), path));
});
