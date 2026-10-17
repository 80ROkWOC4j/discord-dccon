const fs = require('node:fs');

async function syncDev() {
  const {GH_TOKEN, GITHUB_REPOSITORY: repo, RELEASE_TAG: tag} = process.env;
  if (!GH_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^v\d+\.\d+\.\d+$/.test(tag || ''))
    throw Error('Expected a GitHub token, repository and stable release tag.');
  async function request(method, endpoint, body) {
    const response = await fetch(`https://api.github.com/repos/${repo}/${endpoint}`, {
      method, headers: {Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'},
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
    });
    const data = response.status === 204 ? null : await response.json();
    return {status: response.status, data};
  }
  const merged = await request('POST', 'merges', {base: 'dev', head: 'main',
    commit_message: `Merge main into dev after ${tag}`});
  if (merged.status === 201) return `main → dev 동기화 완료: ${merged.data.sha}`;
  if (merged.status === 204) return 'dev에 main 변경이 이미 반영돼 있습니다.';
  if (merged.status !== 409)
    throw Error(`Branch sync failed (HTTP ${merged.status}): ${merged.data?.message}`);

  const head = encodeURIComponent(`${repo.split('/')[0]}:main`);
  const existing = await request('GET', `pulls?state=open&base=dev&head=${head}`);
  if (existing.status !== 200) throw Error(`Could not find sync PRs (HTTP ${existing.status}).`);
  if (existing.data.length) return `병합 충돌: 기존 PR에서 검토해 주세요. ${existing.data[0].html_url}`;

  const created = await request('POST', 'pulls', {
    base: 'dev', head: 'main', title: 'Sync main into dev',
    body: `${tag} 정식 릴리즈 후 main을 dev로 자동 병합하는 과정에서 충돌이 발생했습니다.\n\n` +
      '릴리즈는 정상 발행됐으며 dev는 변경하지 않았습니다. 충돌과 버전 번호를 검토한 뒤 병합해 주세요.\n\n' +
      `실행 기록: https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  });
  if (created.status !== 201) throw Error(`Could not create sync PR (HTTP ${created.status}): ${created.data?.message}`);
  return `병합 충돌: 검토용 PR을 생성했습니다. ${created.data.html_url}`;
}

module.exports = {syncDev};
if (require.main === module) syncDev().then(message => {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, message + '\n');
}).catch(error => {console.error(error.message); process.exitCode = 1;});
