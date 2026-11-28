import type {Platform} from '../platform/types.ts';
import type {Settings} from './types.ts';
import type {SharedConfiguration} from './services.ts';
import {forgetInactiveEmbeddingCredentials} from '../storage/merge.ts';

const EMBEDDING_CHANGE = 'embedding-settings-changed';
const EMBEDDING_KEYS = new Set<keyof Settings>(['embeddingEnabled', 'embeddingProvider', 'embeddingCloudflareCredentials']);
function sameEmbeddingSettings(a: Partial<Settings>, b: Partial<Settings>) {
  const before = a.embeddingCloudflareCredentials, after = b.embeddingCloudflareCredentials;
  return (a.embeddingEnabled === true) === (b.embeddingEnabled === true) &&
    (a.embeddingProvider === 'cloudflare') === (b.embeddingProvider === 'cloudflare') &&
    before?.accountId === after?.accountId && before?.apiToken === after?.apiToken;
}

export function createSettings(platform: Platform, vectorSpec: string) {
  const listeners = new Set<(key: keyof Settings) => void>();
  type EmbeddingSync = {onChange(): void; channel?: BroadcastChannel; timer?: ReturnType<typeof setInterval>; started?: boolean};
  let sync: EmbeddingSync | undefined, embeddingRevision = 0;
  const SharedConfig: SharedConfiguration = {
    data: null, backend: null, pending: [], work: Promise.resolve(),
    async open() {
      this.backend = platform.config || platform.createConfig(vectorSpec);
      applySnapshot((await this.call('open')).settings, false);
      startEmbeddingSync();
    },
    async call(method: 'open' | 'read' | 'save', ...args: [string, unknown, unknown] | []) {
      const backend = this.backend!;
      const result = method === 'save' ? await backend.save(...args as [string, unknown, unknown]) :
        method === 'read' && backend.read ? await backend.read() : await backend.open();
      if (result.error) throw Object.assign(Error(result.error.message), {code: result.error.code});
      return result;
    },
    save(key, value) {
      const operation = {key, value: structuredClone(value), before: key === "embeddingCloudflareCredentials" ? undefined : structuredClone(this.data![key])};
      this.pending.push(operation); this.data![key] = structuredClone(value);
      forgetInactiveEmbeddingCredentials(this.data!);
      const request = this.work.then(async () => {
        const config = await this.call("save", key, operation.value, operation.before);
        this.pending.shift();
        applySnapshot(config.settings);
        // Post only an invalidation, and only after the backend committed the update.
        if (EMBEDDING_KEYS.has(key)) {
          try {sync?.channel?.postMessage(EMBEDDING_CHANGE);} catch { /* Fresh reads still guard requests. */ }
        }
      });
      this.work = request.catch(() => {
        this.pending = this.pending.filter(item => item !== operation);
        if (key === 'embeddingCloudflareCredentials' && this.data?.[key] && !this.pending.some(item => item.key === key)) {
          delete this.data[key]; embeddingRevision++;
        }
        // An error from a settings backend can contain a fragment of config.json.
        platform.logger.error("discord-dccon", "Shared configuration save failed");
        platform.ui.showToast("설정을 저장하지 못했습니다.", {type: "error"});
      });
      return request;
    },
  };

  function applySnapshot(snapshot: Partial<Settings>, notify = true) {
    const before = SharedConfig.data;
    const next = structuredClone(snapshot);
    forgetInactiveEmbeddingCredentials(next);
    for (const pending of SharedConfig.pending) {
      (next as Record<string, unknown>)[pending.key] = structuredClone(pending.value);
      forgetInactiveEmbeddingCredentials(next);
    }
    SharedConfig.data = next;
    const changed = !sameEmbeddingSettings(before ?? {}, next);
    if (changed) {
      embeddingRevision++;
      if (notify) sync?.onChange();
    }
    return changed;
  }

  function refreshEmbeddingSettings(): Promise<boolean> {
    if (!SharedConfig.data || !SharedConfig.backend) return Promise.resolve(false);
    const watching = sync;
    // Order reads with our writes so a late snapshot cannot roll back a committed local change.
    const read = SharedConfig.work.then(async () => {
      if (sync !== watching) return true;
      const snapshot = await SharedConfig.call('read');
      return sync !== watching || applySnapshot(snapshot.settings);
    });
    SharedConfig.work = read.catch(() => {});
    return read;
  }

  function startEmbeddingSync() {
    if (!sync || sync.started || !SharedConfig.data) return;
    const watching = sync;
    watching.started = true;
    if (typeof BroadcastChannel !== 'undefined') try {
      watching.channel = new BroadcastChannel('discord-dccon-embedding-settings-v1');
      watching.channel.onmessage = event => {
        if (sync === watching && event.data === EMBEDDING_CHANGE) void refreshEmbeddingSettings().catch(() => {});
      };
    } catch { /* The host may restrict BroadcastChannel. The store is still shared. */ }
    // Separate desktop profiles do not necessarily share a channel. Observe disk too,
    // so a change can abort a request already in progress in another instance.
    if ((!watching.channel || SharedConfig.backend?.pollForChanges) && typeof setInterval !== 'undefined') {
      let polling = false;
      watching.timer = setInterval(() => {
        if (polling || sync !== watching) return;
        polling = true;
        void refreshEmbeddingSettings().catch(() => {}).finally(() => {polling = false;});
      }, 2_000);
    }
  }

  function watchEmbeddingSettings(onChange: () => void) {
    const watching: EmbeddingSync = sync = {onChange};
    startEmbeddingSync();
    return () => {
      if (sync !== watching) return;
      sync = undefined;
      watching.channel?.close();
      if (watching.timer !== undefined) clearInterval(watching.timer);
    };
  }

  function loadData<K extends keyof Settings>(key: K): Settings[K] | undefined;
  function loadData<K extends keyof Settings>(key: K, defaultData: Settings[K]): Settings[K];
  function loadData<K extends keyof Settings>(key: K, defaultData?: Settings[K]): Settings[K] | undefined {
    defaultData = structuredClone(defaultData);

    // BetterDiscord can return the cached object. Never share it with React state.
    const data = structuredClone(SharedConfig.data ? SharedConfig.data[key] : platform.data.load(key)) as Settings[K] | undefined;
    if (data == null) return defaultData;

    // Only fill missing properties of object settings, never primitive values.
    if (defaultData !== null && typeof defaultData === 'object' && typeof data === 'object') {
      const defaults = defaultData as Record<string, unknown>, existing = data as Record<string, unknown>;
      for (const key of Object.keys(defaults)) if (existing[key] == null && defaults[key] != null) existing[key] = defaults[key];
    }

    return data;
  }

  function embeddingSettings() {
    return {embeddingEnabled: loadData('embeddingEnabled'), embeddingProvider: loadData('embeddingProvider'),
      embeddingCloudflareCredentials: loadData('embeddingCloudflareCredentials')};
  }

  function saveData<K extends keyof Settings>(key: K, data: Settings[K]) {
    const before = EMBEDDING_KEYS.has(key) ? embeddingSettings() : undefined;
    const result = SharedConfig.data ? SharedConfig.save(key, data) : platform.data.save!(key, data);
    if (!SharedConfig.data && ((key === "embeddingEnabled" && data !== true) ||
      (key === "embeddingProvider" && data !== "cloudflare")) && platform.data.load("embeddingCloudflareCredentials") !== undefined) {
      platform.data.save!("embeddingCloudflareCredentials", undefined);
    }
    if (before && !sameEmbeddingSettings(before, embeddingSettings())) embeddingRevision++;
    for (const listener of [...listeners]) listener(key);
    return result;
  }

  return {open: () => SharedConfig.open(), loadData, saveData, isReady: () => SharedConfig.data !== null,
    refreshEmbeddingSettings, watchEmbeddingSettings, getEmbeddingRevision: () => embeddingRevision,
    subscribe(listener: (key: keyof Settings) => void) {listeners.add(listener); return () => {listeners.delete(listener);};}};
}
export type SettingsService = ReturnType<typeof createSettings>;
