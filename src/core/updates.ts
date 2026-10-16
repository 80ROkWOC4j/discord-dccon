import type {Platform} from '../platform/types.ts';

type Version = {numbers: number[]; prerelease: string[]};
function parseVersion(value: unknown): Version | null {
  if (typeof value !== 'string') return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const numbers = match.slice(1, 4).map(Number), prerelease = match[4]?.split('.') || [];
  if (!numbers.every(Number.isSafeInteger) || prerelease.some(part => /^0\d+$/.test(part))) return null;
  return {numbers, prerelease};
}
function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] - b.numbers[i];
  if (!a.prerelease.length || !b.prerelease.length) return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const left = a.prerelease[i], right = b.prerelease[i];
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left), rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric && left.length !== right.length) return left.length - right.length;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

export async function checkForUpdate(net: Platform['net'], currentVersion: string, signal: AbortSignal) {
  const current = parseVersion(currentVersion);
  if (!current) throw Error('현재 버전을 확인할 수 없습니다.');
  let latest: {version: Version; tag: string} | undefined;
  for (let page = 1; ; page++) {
    const response = await net.fetch(`https://api.github.com/repos/80ROkWOC4j/discord-dccon/releases?per_page=100&page=${page}`,
      {signal, headers: {Accept: 'application/vnd.github+json'}});
    if (response.status === 403 || response.status === 429) throw Error('GitHub 조회가 제한되었습니다. 잠시 후 다시 확인해 주세요.');
    if (response.status !== 200) throw Error(`업데이트 정보를 가져오지 못했습니다. (HTTP ${response.status})`);
    const releases: unknown = JSON.parse(await response.text());
    if (!Array.isArray(releases)) throw Error('릴리스 정보를 읽지 못했습니다.');
    for (const release of releases) {
      if (!release || release.draft) continue;
      const version = parseVersion(release.tag_name);
      if (!version || (!current.prerelease.length && (release.prerelease || version.prerelease.length))) continue;
      if (!latest || compareVersions(version, latest.version) > 0) latest = {version, tag: release.tag_name};
    }
    if (releases.length < 100) break;
  }
  return {latestVersion: latest?.tag ?? null, available: !!latest && compareVersions(latest.version, current) > 0};
}
