'use strict';

const { realpathSync, statSync } = require('node:fs');
const { resolve, sep } = require('node:path');
const { spawnSync } = require('node:child_process');

function runBuildHook(root, hook) {
  if (typeof hook !== 'string' || !/^[a-zA-Z0-9_.\/-]+\.sh$/.test(hook) ||
      hook.startsWith('/') || hook.split('/').some(part => !part || part === '..'))
    throw new Error('Build hook must be a repository-relative Bash script.');
  const directory = realpathSync(root);
  const script = realpathSync(resolve(directory, hook));
  if (!script.startsWith(directory + sep) || !statSync(script).isFile())
    throw new Error('Build hook must remain inside the source checkout.');
  const result = spawnSync('bash', [script], { cwd: directory, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('Repository build hook failed.');
}

if (require.main === module) {
  try { runBuildHook('source', process.env.BUILD_HOOK); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { runBuildHook };
