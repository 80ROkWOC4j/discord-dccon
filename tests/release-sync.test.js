const {test} = require('node:test');
const assert = require('node:assert/strict');
const {syncDev} = require('../.github/scripts/sync-dev.cjs');

function setup(t, responses) {
  const env = {GH_TOKEN: 'test-token', GITHUB_REPOSITORY: 'owner/repo', RELEASE_TAG: 'v4.0.0', GITHUB_RUN_ID: '123'};
  for (const [key, value] of Object.entries(env)) {
    const before = process.env[key]; process.env[key] = value;
    t.after(() => {if (before === undefined) delete process.env[key]; else process.env[key] = before;});
  }
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({url, method: options.method, body: options.body && JSON.parse(options.body)});
    const next = responses.shift(); assert.ok(next, 'Unexpected API call');
    return new Response(next.status === 204 ? null : JSON.stringify(next.body), {status: next.status});
  });
  return calls;
}

test('successful merge and already synchronized branches do not create PRs', async t => {
  const calls = setup(t, [{status: 201, body: {sha: 'merged'}}, {status: 204}]);
  assert.match(await syncDev(), /동기화 완료/);
  assert.match(await syncDev(), /이미 반영/);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://api.github.com/repos/owner/repo/merges');
    assert.equal(call.body.base, 'dev'); assert.equal(call.body.head, 'main');
  }
});

test('merge conflict opens a review PR and returns successfully', async t => {
  const url = 'https://github.com/owner/repo/pull/1';
  const calls = setup(t, [{status: 409, body: {message: 'Merge conflict'}}, {status: 200, body: []},
    {status: 201, body: {html_url: url}}]);
  assert.ok((await syncDev()).includes(url));
  assert.equal(calls[1].url, 'https://api.github.com/repos/owner/repo/pulls?state=open&base=dev&head=owner%3Amain');
  assert.equal(calls[2].body.base, 'dev'); assert.equal(calls[2].body.head, 'main');
  assert.match(calls[2].body.body, /v4\.0\.0/);
  assert.match(calls[2].body.body, /actions\/runs\/123/);
});

test('repeated conflict reuses the existing open PR', async t => {
  const url = 'https://github.com/owner/repo/pull/1';
  const calls = setup(t, [{status: 409, body: {}}, {status: 200, body: [{html_url: url}]}]);
  assert.ok((await syncDev()).includes(url));
  assert.equal(calls.length, 2);
});

test('permission errors are not treated as merge conflicts', async t => {
  const calls = setup(t, [{status: 403, body: {message: 'Forbidden'}}]);
  await assert.rejects(syncDev(), /HTTP 403/);
  assert.equal(calls.length, 1);
});

test('failure to create the conflict PR remains visible', async t => {
  setup(t, [{status: 409, body: {}}, {status: 200, body: []}, {status: 403, body: {message: 'PR creation disabled'}}]);
  await assert.rejects(syncDev(), /Could not create sync PR.*403/);
});
