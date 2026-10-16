const {test} = require('node:test');
const assert = require('node:assert/strict');
const {checkForUpdate} = require('../src/core/updates.ts');
const release = (tag_name, options = {}) => ({tag_name, draft: false, prerelease: tag_name.includes('-'), ...options});
const response = releases => ({status: 200, text: async () => JSON.stringify(releases)});

for (const [current, tags, expected, available] of [
  ['4.0.0', ['v4.0.0', 'v4.1.0-beta.1'], 'v4.0.0', false],
  ['4.0.0', ['v4.0.2', 'v4.0.10', 'v4.0.9'], 'v4.0.10', true],
  ['4.0.0-beta.2', ['v3.6.0', 'v4.0.0-beta.10', 'v4.0.0-beta.3'], 'v4.0.0-beta.10', true],
  ['4.0.0-beta.2', ['v4.0.0-beta.2', 'v3.6.0'], 'v4.0.0-beta.2', false],
  ['4.0.0-beta.2', ['v4.0.0-beta.10', 'v4.0.0'], 'v4.0.0', true],
  ['4.0.0-beta.2', ['v4.0.0-rc.1', 'v4.0.0-beta.10'], 'v4.0.0-rc.1', true],
  ['4.0.0', ['v3.6.0'], 'v3.6.0', false],
  ['4.0.0+local', ['v4.0.0'], 'v4.0.0', false],
]) {
  test(`release comparison: ${current}, ${tags.join(', ')}`, async () => {
    const result = await checkForUpdate({fetch: async () => response(tags.map(tag => release(tag)))}, current, new AbortController().signal);
    assert.deepEqual(result, {latestVersion: expected, available});
  });
}

test('ignores drafts, invalid tags, and prereleases marked without a version suffix', async () => {
  const releases = [release('v8.0.0', {draft: true}), release('v7.0.0', {prerelease: true}), release('nightly'), release('v4.0.0-beta.01'), null];
  assert.deepEqual(await checkForUpdate({fetch: async () => response(releases)}, '4.0.0', new AbortController().signal),
    {latestVersion: null, available: false});
});

test('reads later release pages and sends the cancellation signal without downloading assets', async () => {
  const signal = new AbortController().signal, calls = [];
  const result = await checkForUpdate({fetch: async (url, options) => {
    calls.push(url); assert.equal(options.signal, signal);
    assert.equal(options.headers.Accept, 'application/vnd.github+json');
    assert.equal(url, `https://api.github.com/repos/80ROkWOC4j/discord-dccon/releases?per_page=100&page=${calls.length}`);
    return response(calls.length === 1 ? Array.from({length: 100}, () => release('v4.1.0-beta.1')) : [release('v4.0.1')]);
  }}, '4.0.0', signal);
  assert.equal(calls.length, 2);
  assert.deepEqual(result, {latestVersion: 'v4.0.1', available: true});
});

test('HTTP and malformed response errors cannot report an up-to-date result', async () => {
  for (const status of [403, 429, 404, 500]) {
    await assert.rejects(checkForUpdate({fetch: async () => ({status})}, '4.0.0', new AbortController().signal), /조회가 제한|가져오지 못/);
  }
  await assert.rejects(checkForUpdate({fetch: async () => response({})}, '4.0.0', new AbortController().signal), /릴리스 정보/);
  await assert.rejects(checkForUpdate({fetch: async () => {throw Error('offline');}}, '4.0.0', new AbortController().signal), /offline/);
});
