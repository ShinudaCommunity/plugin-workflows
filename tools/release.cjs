const { createReadStream, createWriteStream } = require('node:fs');
const { lstat, mkdir, realpath, rm } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { join, dirname, resolve, sep } = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const maximumSize = 100 * 1024 * 1024;
const check = (condition, message) => { if (!condition) throw new Error(message); };
const namePattern = /^[a-z][a-z0-9-]{0,39}$/;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const tagPattern = /^(?:[a-z][a-z0-9-]{0,39}-)?v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const assetPattern = /^candidate-[a-z][a-z0-9-]{0,39}-[0-9]+\.[0-9]+\.[0-9]+-[1-9][0-9]*-[1-9][0-9]*\.suvio$/;
const safePath = value => typeof value === 'string' && /^[A-Za-z0-9._/-]{1,256}$/.test(value) &&
  value.split('/').every(part => !['', '.', '..'].includes(part));

function validateConfig(config) {
  check(config && config.schemaVersion === 1, 'Unsupported release configuration.');
  check(Object.keys(config).every(key => ['schemaVersion', 'tasks', 'packages'].includes(key)), 'Unknown release configuration field.');
  check(Array.isArray(config.tasks) && config.tasks.length > 0 && config.tasks.length <= 32 &&
    config.tasks.every(task => typeof task === 'string' && /^:?[A-Za-z][A-Za-z0-9:_-]*$/.test(task)) &&
    config.tasks.some(task => /(^|:)check$/.test(task)), 'Release tasks must include checks and cannot contain command options.');
  check(Array.isArray(config.packages) && config.packages.length > 0 && config.packages.length <= 100, 'Expected 1–100 packages.');
  for (const plugin of config.packages) {
    check(Object.keys(plugin).sort().join(',') === 'file,name,tagPrefix' && namePattern.test(plugin.name) &&
      safePath(plugin.file) && /\.(suvio|suvio-plugin)$/.test(plugin.file) &&
      /^(?:[a-z][a-z0-9-]{0,39}-)?v$/.test(plugin.tagPrefix), 'Invalid package configuration.');
  }
  for (const key of ['name', 'file', 'tagPrefix']) {
    check(new Set(config.packages.map(plugin => plugin[key])).size === config.packages.length, 'Duplicate package configuration.');
  }
  return config;
}

function selectedNames(config, selection, tag = '') {
  const names = selection === 'all' ? config.packages.map(plugin => plugin.name) : selection === 'tag' ?
    config.packages.filter(plugin => tag.startsWith(plugin.tagPrefix) &&
      versionPattern.test(tag.slice(plugin.tagPrefix.length))).map(plugin => plugin.name) : selection.split(',');
  check(names.length > 0 && new Set(names).size === names.length &&
    names.every(name => config.packages.some(plugin => plugin.name === name)), 'Unknown or duplicate plugin selection.');
  return names;
}

async function regularFile(root, relative) {
  check(safePath(relative), 'Unsafe candidate path.');
  const base = await realpath(root);
  const file = resolve(base, relative);
  const status = await lstat(file);
  check(status.isFile() && status.nlink === 1 && (await realpath(file)) === file && file.startsWith(base + sep) &&
    status.size > 0 && status.size <= maximumSize, 'Invalid candidate file.');
  return { file, size: status.size };
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function verifyTag(root, tag, defaultBranch) {
  check(tagPattern.test(tag) && /^[A-Za-z0-9._/-]+$/.test(defaultBranch) && !defaultBranch.includes('..'), 'Invalid release ref.');
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  check(git(['cat-file', '-t', `refs/tags/${tag}`]) === 'tag', 'An annotated release tag is required.');
  const commit = git(['rev-parse', 'HEAD']);
  check(git(['rev-parse', `refs/tags/${tag}^{commit}`]) === commit, 'Release checkout does not match its tag.');
  git(['merge-base', '--is-ancestor', commit, `origin/${defaultBranch}`]);
  check(git(['status', '--porcelain']) === '', 'Release source is not clean.');
  return commit;
}

async function collectCandidates({ root, config, tag = '', commit, selection = 'all' }) {
  validateConfig(config);
  check(/^[0-9a-f]{40}$/.test(commit), 'Invalid release source.');
  const selected = selectedNames(config, selection, tag);
  const candidates = [];
  for (const plugin of config.packages) {
    const { file, size } = await regularFile(root, plugin.file);
    let manifest;
    try {
      manifest = JSON.parse(execFileSync('unzip', ['-p', file, 'suvio.plugin.json'],
        { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch { throw new Error('Cannot read a bounded candidate manifest.'); }
    // This reads public identity only. The existing SDK publisher performs full ZIP,
    // manifest, Wasm and signature validation again before it signs or uploads anything.
    check(manifest.formatVersion === 8 && manifest.identity &&
      /^[a-z0-9][a-z0-9.-]{2,63}$/.test(manifest.identity.id) &&
      versionPattern.test(manifest.identity.version), 'Expected a stable V8 package identity.');
    candidates.push({ plugin: plugin.name, file: plugin.file, pluginId: manifest.identity.id,
      version: manifest.identity.version, size, sha256: await digest(file) });
  }
  check(new Set(candidates.map(candidate => candidate.pluginId)).size === candidates.length, 'Duplicate plugin identity.');
  if (tag) check(tagPattern.test(tag) && config.packages.some((plugin, index) =>
    selected.includes(plugin.name) && tag === `${plugin.tagPrefix}${candidates[index].version}`), 'Tag does not match a selected package version.');
  return { tag, commit, selected, candidates };
}

async function uploadCandidates({ github, context, root, evidence, runId, attempt }) {
  check(tagPattern.test(evidence.tag) && /^[0-9a-f]{40}$/.test(evidence.commit) &&
    /^[1-9][0-9]*$/.test(String(runId)) && /^[1-9][0-9]*$/.test(String(attempt)), 'Invalid release run.');
  // Validate every file before any API mutation, including a changed file after inspection.
  for (const candidate of evidence.candidates) {
    const { file, size } = await regularFile(root, candidate.file);
    check(size === candidate.size && await digest(file) === candidate.sha256, 'Candidate changed after verification.');
  }
  const ref = (await github.rest.git.getRef({ ...context.repo, ref: `tags/${evidence.tag}` })).data.object;
  check(ref.type === 'tag', 'An annotated release tag is required.');
  const target = (await github.rest.git.getTag({ ...context.repo, tag_sha: ref.sha })).data.object;
  check(target.type === 'commit' && target.sha === evidence.commit, 'The release tag has changed.');
  const releases = await github.paginate(github.rest.repos.listReleases, { ...context.repo, per_page: 100 });
  const matches = releases.filter(release => release.tag_name === evidence.tag);
  check(matches.length <= 1 && matches.every(release => release.draft), 'A published release cannot be replaced.');
  const release = matches[0] ?? (await github.rest.repos.createRelease({ ...context.repo,
    tag_name: evidence.tag, name: `Plugin candidates ${evidence.tag}`, draft: true,
    body: 'Verified build candidates. Publisher signing and Suvio Store review are pending. Track publication in Shinuda Console; these candidates are not approved Store artifacts.' })).data;
  const uploaded = { ...evidence, candidates: [] };
  for (const candidate of evidence.candidates) {
    const name = `candidate-${candidate.plugin}-${candidate.version}-${runId}-${attempt}.suvio`;
    check(assetPattern.test(name), 'Invalid candidate asset name.');
    const asset = (await github.rest.repos.uploadReleaseAsset({ ...context.repo, release_id: release.id, name,
      headers: { 'content-type': 'application/octet-stream', 'content-length': candidate.size },
      data: createReadStream(join(root, candidate.file)) })).data;
    uploaded.candidates.push({ ...candidate, name, assetId: asset.id });
  }
  const data = Buffer.from(JSON.stringify(uploaded, null, 2) + '\n');
  await github.rest.repos.uploadReleaseAsset({ ...context.repo, release_id: release.id,
    name: `release-candidate-${runId}-${attempt}.json`,
    headers: { 'content-type': 'application/json', 'content-length': data.length }, data });
  return uploaded;
}

function publicationMatrix(evidence) {
  const selected = evidence.candidates.filter(candidate => evidence.selected.includes(candidate.plugin));
  check(selected.length === evidence.selected.length && selected.length > 0, 'Invalid publication selection.');
  return { include: selected.map(candidate => ({ plugin: candidate.plugin, 'plugin-id': candidate.pluginId,
    version: candidate.version, 'asset-id': candidate.assetId, sha256: candidate.sha256, 'asset-name': candidate.name })) };
}

async function downloadCandidate({ github, context, assetId, sha256, name, destination }) {
  check(/^[1-9][0-9]*$/.test(String(assetId)) && /^[0-9a-f]{64}$/.test(sha256) && assetPattern.test(name), 'Invalid candidate reference.');
  const asset = (await github.rest.repos.getReleaseAsset({ ...context.repo, asset_id: Number(assetId) })).data;
  check(asset.name === name && asset.state === 'uploaded' && asset.size > 0 && asset.size <= maximumSize &&
    (!asset.digest || asset.digest === `sha256:${sha256}`), 'Candidate metadata does not match.');
  const response = await github.rest.repos.getReleaseAsset({ ...context.repo, asset_id: Number(assetId),
    headers: { accept: 'application/octet-stream' }, request: { parseSuccessResponseBody: false } });
  check(typeof response.data?.getReader === 'function', 'A bounded download stream is required.');
  await mkdir(dirname(destination), { recursive: true });
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  await new Promise((resolveOpen, reject) => { output.once('open', resolveOpen); output.once('error', reject); });
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    await pipeline(Readable.fromWeb(response.data), new Transform({ transform(chunk, encoding, done) {
      bytes += chunk.length;
      if (bytes > asset.size || bytes > maximumSize) return done(new Error('Candidate exceeds its declared size.'));
      hash.update(chunk);
      done(null, chunk);
    } }), output);
    check(bytes === asset.size && hash.digest('hex') === sha256, 'Candidate checksum does not match.');
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
}

module.exports = { validateConfig, selectedNames, verifyTag, collectCandidates, uploadCandidates,
  publicationMatrix, downloadCandidate };
