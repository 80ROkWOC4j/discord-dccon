const fs = require('node:fs');
const {execFileSync, spawnSync} = require('node:child_process');

const git = (...args) => execFileSync('git', args, {encoding: 'utf8'}).trim();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function releaseContext() {
  const {GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA, RELEASE_VERSION} = process.env;
  if (GITHUB_EVENT_NAME !== 'workflow_dispatch' || GITHUB_REF !== 'refs/heads/main')
    throw Error('Manual releases must run from main.');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(RELEASE_VERSION || ''))
    throw Error('Enter a stable version such as 4.0.0, without v or a prerelease suffix.');
  if (git('rev-parse', 'HEAD') !== GITHUB_SHA) throw Error('Checkout does not match the selected commit.');
  const tag = `v${RELEASE_VERSION}`;
  const exists = spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], {stdio: 'ignore'}).status === 0;
  if (exists && Number(process.env.GITHUB_RUN_ATTEMPT || 1) <= 1)
    throw Error(`Tag ${tag} already exists. Re-run the original failed workflow to resume publication.`);
  return {version: RELEASE_VERSION, tag, exists};
}

function prepare() {
  const {version, tag, exists} = releaseContext();
  if (git('status', '--porcelain')) throw Error('Release checkout must be clean.');
  const pkg = read('package.json'), lock = read('package-lock.json');
  const current = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(pkg.version);
  if (!current) throw Error('Invalid current version.');
  const next = version.split('.').map(BigInt), previous = current.slice(1, 4).map(BigInt);
  const different = next.findIndex((value, i) => value !== previous[i]);
  if (different < 0 ? !current[4] : next[different] < previous[different])
    throw Error('Release version must be newer than the current version.');
  if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version)
    throw Error('Package and lockfile versions disagree.');
  pkg.version = lock.version = lock.packages[''].version = version;
  write('package.json', pkg);
  write('package-lock.json', lock);
  // A retry may reuse only the exact tree previously validated and tagged.
  if (exists) {
    if (git('rev-parse', `${tag}^`) !== process.env.GITHUB_SHA)
      throw Error('Existing release tag has a different parent.');
    git('diff', '--exit-code', tag, '--');
  }
}

function publishTag() {
  const {version, tag, exists} = releaseContext();
  const pkg = read('package.json'), lock = read('package-lock.json');
  if ([pkg.version, lock.version, lock.packages[''].version].some(value => value !== version))
    throw Error('Release version was not prepared.');
  const changed = git('diff', '--name-only', 'HEAD', '--').split('\n').filter(Boolean);
  if (changed.some(file => !['package.json', 'package-lock.json'].includes(file)) ||
      git('ls-files', '--others', '--exclude-standard'))
    throw Error('Unexpected changes after release validation.');
  if (exists) {
    if (git('rev-parse', `${tag}^`) !== process.env.GITHUB_SHA)
      throw Error('Existing release tag has a different parent.');
    git('diff', '--exit-code', tag, '--');
    return;
  }
  git('add', 'package.json', 'package-lock.json');
  git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', `Bump version to ${version}`);
  git('-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'tag', '-a', tag, '-m', tag);
  // Reject concurrent changes to main; never publish just one of the two refs.
  git('push', '--atomic', 'origin', 'HEAD:refs/heads/main', `refs/tags/${tag}`);
}

try {
  if (process.argv[2] === 'prepare') prepare();
  else if (process.argv[2] === 'publish-tag') publishTag();
  else throw Error('Expected prepare or publish-tag.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
