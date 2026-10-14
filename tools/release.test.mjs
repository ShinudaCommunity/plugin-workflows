import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import release from './release.cjs';

const commit = '0123456789abcdef0123456789abcdef01234567';
const context = { repo: { owner: 'ShinudaCommunity', repo: 'example' } };
const config = (names = ['first', 'second']) => ({ schemaVersion: 1, tasks: ['check', 'packageSuvioPlugin'],
  packages: names.map((name, index) => ({ name, file: `${name}/build/distributions/${name}.suvio`, tagPrefix: index ? `${name}-v` : 'v' })) });
const versions = { first: '1.2.3', second: '2.0.0', single: '1.0.0' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t, definition = config(), transform = value => value) {
  const root = await mkdtemp(join(tmpdir(), 'suvio-plugin-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const plugin of definition.packages) {
    const file = join(root, plugin.file);
    await mkdir(join(file, '..'), { recursive: true });
    const manifest = transform({ formatVersion: 8, identity: { id: `example.${plugin.name}`, version: versions[plugin.name] },
      builtWith: { sdk: '1.0.0-rc.54' } });
    const contents = join(root, 'fixture-' + plugin.name);
    await mkdir(contents);
    await writeFile(join(contents, 'suvio.plugin.json'), JSON.stringify(manifest));
    execFileSync('jar', ['--create', '--file', file, '-C', contents, '.'], { stdio: 'pipe' });
  }
  return root;
}

function githubMock({ tag = 'v1.2.3', published = false, targetCommit = commit, refType = 'tag', bytes, asset = {}, downloaded } = {}) {
  const uploads = [];
  let creations = 0;
  const github = {
    paginate: async () => published ? [{ id: 7, tag_name: tag, draft: false }] : [],
    rest: {
      git: {
        getRef: async () => ({ data: { object: { type: refType, sha: '1'.repeat(40) } } }),
        getTag: async () => ({ data: { object: { type: 'commit', sha: targetCommit } } }),
      },
      repos: {
        createRelease: async parameters => { creations++; assert.equal(parameters.draft, true); return { data: { id: 7 } }; },
        uploadReleaseAsset: async parameters => {
          const data = Buffer.isBuffer(parameters.data) ? parameters.data : Buffer.concat(await Array.fromAsync(parameters.data));
          uploads.push({ name: parameters.name, data });
          return { data: { id: uploads.length } };
        },
        getReleaseAsset: async parameters => {
          if (!parameters.headers) return { data: { name: 'candidate-first-1.2.3-123-1.suvio', state: 'uploaded', size: bytes.length,
            digest: `sha256:${hash(bytes)}`, ...asset } };
          assert.equal(parameters.headers.accept, 'application/octet-stream');
          assert.equal(parameters.request.parseSuccessResponseBody, false);
          return { data: new ReadableStream({ start(controller) { controller.enqueue(downloaded ?? bytes); controller.close(); } }) };
        },
      },
    },
  };
  return { github, uploads, creations: () => creations };
}

test('one or several packages use manifest identities and independently selected versions', async t => {
  for (const names of [['single'], ['first', 'second']]) {
    const definition = config(names);
    const root = await fixture(t, definition);
    const evidence = await release.collectCandidates({ root, config: definition, commit, tag: `v${versions[names[0]]}` });
    assert.deepEqual(evidence.candidates.map(value => value.version), names.map(name => versions[name]));
    const mock = githubMock();
    const uploaded = await release.uploadCandidates({ github: mock.github, context, root, evidence, runId: 123, attempt: 1 });
    assert.equal(mock.creations(), 1);
    assert.equal(mock.uploads.length, names.length + 1);
    assert.equal(release.publicationMatrix(uploaded).include.length, names.length);
    for (let index = 0; index < names.length; index++) assert.deepEqual(mock.uploads[index].data, await readFile(join(root, definition.packages[index].file)));
    if (names.length > 1) {
      const selected = await release.collectCandidates({ root, config: definition, commit, tag: 'second-v2.0.0', selection: 'second' });
      const uploadedSelection = await release.uploadCandidates({ github: mock.github, context, root, evidence: selected, runId: 123, attempt: 2 });
      assert.deepEqual(release.publicationMatrix(uploadedSelection).include.map(value => value.plugin), ['second']);
      await assert.rejects(release.collectCandidates({ root, config: definition, commit, tag: 'v1.2.3', selection: 'second' }));
    }
    await assert.rejects(release.collectCandidates({ root, config: definition, commit, tag: 'v9.9.9' }));
    await assert.rejects(release.collectCandidates({ root, config: definition, commit, selection: 'unknown' }));
  }
});

test('invalid release configuration fails before executing a build or opening candidates', () => {
  for (const change of [
    value => { value.tasks = ['check;echo']; }, value => { value.tasks = ['-Iinit.gradle']; },
    value => { value.tasks = ['packageSuvioPlugin']; }, value => { value.packages[0].file = '../outside.suvio'; },
    value => { value.packages[0].file = '/tmp/package.suvio'; }, value => { value.packages[1].name = value.packages[0].name; },
    value => { value.packages[1].tagPrefix = 'v'; },
    value => { value.unknown = true; },
  ]) { const definition = config(); change(definition); assert.throws(() => release.validateConfig(definition)); }
  assert.throws(() => release.selectedNames(config(), 'first,first'));
  assert.throws(() => release.selectedNames(config(), ''));
  assert.deepEqual(release.selectedNames(config(), 'tag', 'second-v2.0.0'), ['second']);
  assert.deepEqual(release.selectedNames(config(), 'tag', 'v1.2.3'), ['first']);
  assert.throws(() => release.selectedNames(config(), 'tag', 'unknown-v1.0.0'));
});

test('unsafe or inconsistent candidate packages never become release assets', async t => {
  for (const [name, transform] of [
    ['old manifest format', manifest => ({ ...manifest, formatVersion: 4 })],
    ['top-level legacy identity', manifest => ({ formatVersion: 8, id: manifest.identity.id, version: manifest.identity.version })],
    ['invalid version', manifest => ({ ...manifest, identity: { ...manifest.identity, version: '1.0.0\ninvalid' } })],
    ['duplicate plugin identity', manifest => ({ ...manifest, identity: { ...manifest.identity, id: 'cc.example.duplicate' } })],
  ]) await t.test(name, async t => {
    const root = await fixture(t, config(), transform);
    await assert.rejects(release.collectCandidates({ root, config: config(), commit }));
  });
  for (const mode of ['symlink', 'parent-symlink', 'hardlink', 'oversized-manifest']) await t.test(mode, async t => {
    const definition = config(['single']);
    const root = await fixture(t, definition);
    const file = join(root, definition.packages[0].file);
    if (mode === 'symlink' || mode === 'hardlink') {
      const saved = join(root, 'saved.suvio');
      await writeFile(saved, await readFile(file));
      await rm(file);
      if (mode === 'symlink') await symlink(saved, file); else await link(saved, file);
    } else if (mode === 'parent-symlink') {
      const saved = join(root, 'saved');
      await mkdir(saved);
      await writeFile(join(saved, 'single.suvio'), await readFile(file));
      await rm(join(root, 'single/build/distributions'), { recursive: true });
      await symlink(saved, join(root, 'single/build/distributions'));
    } else {
      const contents = join(root, 'oversized');
      await mkdir(contents);
      await writeFile(join(contents, 'suvio.plugin.json'), ' '.repeat(2 * 1024 * 1024));
      execFileSync('jar', ['--create', '--file', file, '-C', contents, '.'], { stdio: 'pipe' });
    }
    await assert.rejects(release.collectCandidates({ root, config: definition, commit }));
  });
});

test('moved tags, published releases and changed candidates fail before any GitHub mutation', async t => {
  const root = await fixture(t);
  const evidence = await release.collectCandidates({ root, config: config(), commit, tag: 'v1.2.3' });
  for (const options of [{ targetCommit: 'f'.repeat(40) }, { refType: 'commit' }, { published: true }]) {
    const mock = githubMock(options);
    await assert.rejects(release.uploadCandidates({ github: mock.github, context, root, evidence, runId: 123, attempt: 1 }));
    assert.equal(mock.creations(), 0); assert.equal(mock.uploads.length, 0);
  }
  await writeFile(join(root, config().packages[1].file), 'changed after verification');
  const mock = githubMock();
  await assert.rejects(release.uploadCandidates({ github: mock.github, context, root, evidence, runId: 123, attempt: 1 }));
  assert.equal(mock.creations(), 0); assert.equal(mock.uploads.length, 0);
});

test('candidate transfer rejects metadata and byte corruption without overwriting existing files', async t => {
  const root = await fixture(t);
  const bytes = await readFile(join(root, config().packages[0].file));
  const parameters = { context, assetId: 1, sha256: hash(bytes), name: 'candidate-first-1.2.3-123-1.suvio' };
  const destination = join(root, 'candidate.suvio');
  await release.downloadCandidate({ ...parameters, github: githubMock({ bytes }).github, destination });
  assert.deepEqual(await readFile(destination), bytes);
  await assert.rejects(release.downloadCandidate({ ...parameters, github: githubMock({ bytes }).github, destination }));
  assert.deepEqual(await readFile(destination), bytes);
  for (const options of [
    { asset: { name: 'different.suvio' } }, { asset: { state: 'new' } }, { asset: { size: 100 * 1024 * 1024 + 1 } },
    { asset: { digest: `sha256:${'f'.repeat(64)}` } }, { downloaded: bytes.subarray(0, -1) },
    { downloaded: Buffer.alloc(bytes.length) }, { downloaded: Buffer.concat([bytes, bytes]) },
  ]) {
    const rejected = join(root, 'rejected.suvio');
    await assert.rejects(release.downloadCandidate({ ...parameters, github: githubMock({ bytes, ...options }).github, destination: rejected }));
    await assert.rejects(access(rejected));
  }
});

test('only clean annotated tags accepted into the default branch can release', async t => {
  const root = await fixture(t, config(['single']));
  const git = args => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  git(['init', '--initial-branch=main']);
  git(['add', '.']);
  git(['-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Synthetic candidate']);
  const source = git(['rev-parse', 'HEAD']);
  git(['update-ref', 'refs/remotes/origin/main', source]);
  git(['-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid', 'tag', '-a', 'v1.0.0', '-m', 'Synthetic release']);
  assert.equal(release.verifyTag(root, 'v1.0.0', 'main'), source);
  git(['tag', 'v1.0.1']);
  assert.throws(() => release.verifyTag(root, 'v1.0.1', 'main'));
  await writeFile(join(root, 'dirty.txt'), 'uncommitted');
  assert.throws(() => release.verifyTag(root, 'v1.0.0', 'main'));
  git(['add', '.']);
  git(['-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Unreviewed source']);
  git(['-c', 'user.name=Release test', '-c', 'user.email=test@example.invalid', 'tag', '-a', 'v1.0.2', '-m', 'Unreviewed release']);
  assert.throws(() => release.verifyTag(root, 'v1.0.2', 'main'));
});
