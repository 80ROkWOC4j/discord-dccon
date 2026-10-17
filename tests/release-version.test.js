const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync, spawnSync} = require('node:child_process');

const script = path.resolve(__dirname, '../.github/scripts/release-version.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dccon-release-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo'), remote = path.join(root, 'remote.git');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, {cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Release test');
  git('config', 'user.email', 'release@example.invalid');
  const write = (file, data) => fs.writeFileSync(path.join(repo, file), JSON.stringify(data, null, 2) + '\n');
  write('package.json', {name: 'test', version: '4.0.0-beta.5'});
  write('package-lock.json', {name: 'test', version: '4.0.0-beta.5', lockfileVersion: 3,
    packages: {'': {name: 'test', version: '4.0.0-beta.5'}}});
  git('add', '.'); git('commit', '-m', 'Initial');
  git('init', '--bare', '--initial-branch=main', remote);
  git('remote', 'add', 'origin', remote); git('push', 'origin', 'main');
  const sha = git('rev-parse', 'HEAD');
  const run = (command, env = {}) => spawnSync(process.execPath, [script, command], {cwd: repo, encoding: 'utf8',
    env: {...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
      GITHUB_SHA: sha, RELEASE_VERSION: '4.0.0', GITHUB_RUN_ATTEMPT: '1', ...env}});
  const read = file => JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
  return {repo, remote, git, sha, run, read};
}
const success = result => assert.equal(result.status, 0, result.stderr);
const failure = (result, message) => {assert.notEqual(result.status, 0); assert.match(result.stderr, message);};

test('manual release validates locally, then pushes the version commit and tag together', t => {
  const f = fixture(t);
  success(f.run('prepare'));
  assert.equal(f.read('package.json').version, '4.0.0');
  assert.equal(f.read('package-lock.json').packages[''].version, '4.0.0');
  assert.equal(f.git('rev-parse', 'HEAD'), f.sha);
  assert.equal(f.git('ls-remote', '--tags', 'origin'), '');
  success(f.run('publish-tag'));
  const commit = f.git('rev-parse', 'HEAD');
  assert.notEqual(commit, f.sha);
  assert.equal(f.git('rev-parse', 'v4.0.0^{}'), commit);
  assert.match(f.git('ls-remote', 'origin', 'refs/heads/main'), new RegExp(`^${commit}\\s`));
  assert.match(f.git('ls-remote', 'origin', 'refs/tags/v4.0.0^{}'), new RegExp(`^${commit}\\s`));
  assert.equal(f.git('status', '--porcelain'), '');
});

test('manual release rejects other branches, invalid versions and downgrades without modifying files', t => {
  const f = fixture(t);
  for (const env of [{GITHUB_REF: 'refs/heads/dev'}, {GITHUB_EVENT_NAME: 'push'},
    ...['v4.0.0', '4.0.0-beta.6', '04.0.0', '3.9.9', '4.0.0; echo bad'].map(RELEASE_VERSION => ({RELEASE_VERSION}))]) {
    assert.notEqual(f.run('prepare', env).status, 0);
    assert.equal(f.git('status', '--porcelain'), '');
  }
});

test('failed publication can retry the exact tagged tree without creating a second commit', t => {
  const f = fixture(t);
  success(f.run('prepare')); success(f.run('publish-tag'));
  const commit = f.git('rev-parse', 'HEAD');
  f.git('checkout', '--detach', f.sha);
  failure(f.run('prepare'), /already exists/);
  success(f.run('prepare', {GITHUB_RUN_ATTEMPT: '2'}));
  success(f.run('publish-tag', {GITHUB_RUN_ATTEMPT: '2'}));
  assert.equal(f.git('rev-parse', 'v4.0.0^{}'), commit);
  assert.equal(f.git('rev-parse', 'HEAD'), f.sha);
});

test('retry refuses an existing tag whose source differs from the prepared release', t => {
  const f = fixture(t);
  success(f.run('prepare'));
  fs.writeFileSync(path.join(f.repo, 'unexpected.txt'), 'different source');
  f.git('add', '.'); f.git('commit', '-m', 'Different source'); f.git('tag', 'v4.0.0');
  f.git('checkout', '--detach', f.sha);
  assert.notEqual(f.run('prepare', {GITHUB_RUN_ATTEMPT: '2'}).status, 0);
});

test('concurrent changes to main reject the atomic push without publishing the tag', t => {
  const f = fixture(t);
  success(f.run('prepare'));
  // Advance the remote independently of the checkout under validation.
  const tree = f.git('rev-parse', 'HEAD^{tree}');
  const concurrent = f.git('commit-tree', tree, '-p', f.sha, '-m', 'Concurrent change');
  f.git('push', 'origin', `${concurrent}:refs/heads/main`);
  failure(f.run('publish-tag'), /atomic|rejected/);
  assert.equal(f.git('ls-remote', '--tags', 'origin'), '');
  assert.match(f.git('ls-remote', 'origin', 'refs/heads/main'), new RegExp(`^${concurrent}\\s`));
});
