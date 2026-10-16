type ListItem = {info?: {package_idx: string | number}; path?: string; ext?: string};
const listKeys = new Set(['dccons', 'favorites', 'recent', 'personalCons']);
function itemKey(key: string, item: ListItem) {
  return key === 'dccons' ? String(item.info!.package_idx) : item.path + ':' + item.ext;
}
function same(a: unknown, b: unknown) {return JSON.stringify(a) === JSON.stringify(b);}
export function mergeSetting(key: string, before: unknown, next: unknown, current: unknown): unknown {
  if (listKeys.has(key) && Array.isArray(next)) {
    const previous = new Map(((before || []) as ListItem[]).map(item => [itemKey(key, item), item]));
    const desired = new Map((next as ListItem[]).map(item => [itemKey(key, item), item]));
    const latest = new Map(((current || []) as ListItem[]).map(item => [itemKey(key, item), item]));
    for (const id of previous.keys()) if (!desired.has(id)) latest.delete(id);
    const ordered = new Map<string, ListItem>();
    for (const [id, item] of desired) {
      if (!previous.has(id) || !same(previous.get(id), item)) latest.set(id, item);
      if (latest.has(id)) ordered.set(id, latest.get(id)!);
    }
    for (const [id, item] of latest) if (!ordered.has(id)) ordered.set(id, item);
    return [...ordered.values()];
  }
  if (key === 'collapsedPacks' && next && typeof next === 'object') {
    const previous = before as Record<string, unknown> | undefined;
    const desired = next as Record<string, unknown>;
    const result = {...current as Record<string, unknown>};
    for (const name of new Set([...Object.keys(before || {}), ...Object.keys(next)])) {
      if (same(previous?.[name], desired[name])) continue;
      if (Object.hasOwn(next, name)) result[name] = desired[name]; else delete result[name];
    }
    return result;
  }
  return next;
}
