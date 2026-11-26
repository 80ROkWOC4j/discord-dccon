const fs = require('node:fs');
const {execFileSync, spawnSync} = require('node:child_process');

const git = (...args) => execFileSync('git', args, {encoding: 'utf8'}).trim();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value || '');
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  if (prerelease.some(part => /^0\d+$/.test(part))) return null;
  return {base: match.slice(1, 4).join('.'), numbers: match.slice(1, 4).map(BigInt), prerelease};
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i] ? 1 : -1;
  if (!a.prerelease.length || !b.prerelease.length) return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i], right = b.prerelease[i];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) return BigInt(left) > BigInt(right) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

function tagExists(tag) {
  return spawnSync('git', ['rev-parse', '--verify', `refs/tags/${tag}`], {stdio: 'ignore'}).status === 0;
}

function tagParent(tag) {
  const result = spawnSync('git', ['rev-parse', '--verify', `${tag}^`], {encoding: 'utf8'});
  return result.status === 0 ? result.stdout.trim() : null;
}

function resolveBetaVersion(input, headVersion, sha, attempt) {
  const explicit = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/.exec(input || '');
  if (explicit) {
    const base = explicit.slice(1, 4).join('.');
    if (tagExists(`v${base}`)) throw Error(`Stable tag v${base} already exists.`);
    return input;
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input || ''))
    throw Error('On dev, enter a base version such as 4.2.0 (auto beta.N) or an explicit beta version such as 4.2.0-beta.1.');
  if (tagExists(`v${input}`)) throw Error(`Stable tag v${input} already exists.`);
  const tags = git('tag', '-l', `v${input}-beta.*`).split('\n').filter(Boolean);
  const pattern = new RegExp(`^v${input.replaceAll('.', '\\.')}-beta\\.([1-9]\\d*)$`);
  let maxBeta = 0;
  for (const name of tags) {
    const match = pattern.exec(name);
    if (match) maxBeta = Math.max(maxBeta, Number(match[1]));
  }
  if (attempt > 1 && maxBeta > 0 && tagParent(`v${input}-beta.${maxBeta}`) === sha) {
    return `${input}-beta.${maxBeta}`;
  }
  const headBeta = new RegExp(`^${input.replaceAll('.', '\\.')}-beta\\.([1-9]\\d*)$`).exec(headVersion);
  if (headBeta) maxBeta = Math.max(maxBeta, Number(headBeta[1]));
  return `${input}-beta.${maxBeta + 1}`;
}

function releaseContext() {
  const {GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_SHA, RELEASE_VERSION} = process.env;
  if (GITHUB_EVENT_NAME !== 'workflow_dispatch' || !['refs/heads/main', 'refs/heads/dev'].includes(GITHUB_REF || ''))
    throw Error('Manual releases must run from main or dev.');
  if (git('rev-parse', 'HEAD') !== GITHUB_SHA) throw Error('Checkout does not match the selected commit.');
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT || 1);
  const isDev = GITHUB_REF === 'refs/heads/dev';
  const headPkg = JSON.parse(git('show', 'HEAD:package.json'));
  let version;
  if (isDev) {
    version = resolveBetaVersion(RELEASE_VERSION, headPkg.version, GITHUB_SHA, attempt);
  } else {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(RELEASE_VERSION || ''))
      throw Error('Enter a stable version such as 4.0.0, without v or a prerelease suffix.');
    version = RELEASE_VERSION;
  }
  const tag = `v${version}`;
  const exists = tagExists(tag);
  if (exists && attempt <= 1)
    throw Error(`Tag ${tag} already exists. Re-run the original failed workflow to resume publication.`);
  return {version, tag, exists, targetRef: GITHUB_REF, isDev};
}

function prepare() {
  const {version, tag, exists} = releaseContext();
  if (git('status', '--porcelain')) throw Error('Release checkout must be clean.');
  const pkg = read('package.json'), lock = read('package-lock.json');
  const current = parseVersion(pkg.version), next = parseVersion(version);
  if (!current || !next) throw Error('Invalid current version.');
  if (compareVersions(next, current) <= 0)
    throw Error('Release version must be newer than the current version.');
  if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version)
    throw Error('Package and lockfile versions disagree.');
  pkg.version = lock.version = lock.packages[''].version = version;
  write('package.json', pkg);
  write('package-lock.json', lock);
  if (process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `RELEASE_TAG=${tag}\nRELEASE_VERSION=${version}\n`);
  }
  // A retry may reuse only the exact tree previously validated and tagged.
  if (exists) {
    if (git('rev-parse', `${tag}^`) !== process.env.GITHUB_SHA)
      throw Error('Existing release tag has a different parent.');
    git('diff', '--exit-code', tag, '--');
  }
}

function publishTag() {
  const {version, tag, exists, targetRef} = releaseContext();
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
  // Reject concurrent changes to the target branch; never publish just one of the two refs.
  git('push', '--atomic', 'origin', `HEAD:${targetRef}`, `refs/tags/${tag}`);
}

try {
  if (process.argv[2] === 'prepare') prepare();
  else if (process.argv[2] === 'publish-tag') publishTag();
  else throw Error('Expected prepare or publish-tag.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
