import type {Platform} from '../platform/types.ts';
import type {Settings} from './types.ts';
import type {SharedConfiguration} from './services.ts';
export function createSettings(platform: Platform, vectorSpec: string) {
  const listeners = new Set<(key: keyof Settings) => void>();
  const SharedConfig: SharedConfiguration = {
    data: null, backend: null, pending: [], work: Promise.resolve(),
    async open() {
      this.backend = platform.config || platform.createConfig(vectorSpec);
      this.data = structuredClone((await this.call("open")).settings);
    },
    async call(method: 'open' | 'save', ...args: [string, unknown, unknown] | []) {
      const result = method === 'open' ? await this.backend!.open() : await this.backend!.save(...args as [string, unknown, unknown]);
      if (result.error) throw Object.assign(Error(result.error.message), {code: result.error.code});
      return result;
    },
    save(key, value) {
      const operation = {key, value: structuredClone(value), before: structuredClone(this.data![key])};
      this.pending.push(operation); this.data![key] = structuredClone(value);
      const request = this.work.then(async () => {
        const config = await this.call("save", key, operation.value, operation.before);
        this.pending.shift(); this.data = structuredClone(config.settings);
        for (const pending of this.pending) (this.data as Record<string, unknown>)[pending.key] = structuredClone(pending.value);
      });
      this.work = request.catch(error => {
        this.pending = this.pending.filter(item => item !== operation);
        platform.logger.error("discord-dccon", "Shared configuration save failed", error);
        platform.ui.showToast("설정 저장 실패: " + error.message, {type: "error"});
      });
      return request;
    },
  };
  function loadData<K extends keyof Settings>(key: K): Settings[K] | undefined;
  function loadData<K extends keyof Settings>(key: K, defaultData: Settings[K]): Settings[K];
  function loadData<K extends keyof Settings>(key: K, defaultData?: Settings[K]): Settings[K] | undefined {
    defaultData = structuredClone(defaultData);

    // BetterDiscord can return the cached object. Never share it with React state.
    const data = structuredClone(SharedConfig.data ? SharedConfig.data[key] : platform.data.load(key)) as Settings[K] | undefined;
    if (data == null) return defaultData;

    // 기본값 처리
    for (const k in defaultData) {
      if (data[k] == null && defaultData[k] != null) {
        data[k] = defaultData[k];
      }
    }

    return data;
  }

  function saveData<K extends keyof Settings>(key: K, data: Settings[K]) {
    const result = SharedConfig.data ? SharedConfig.save(key, data) : platform.data.save!(key, data);
    for (const listener of [...listeners]) listener(key);
    return result;
  }

  return {open: () => SharedConfig.open(), loadData, saveData, isReady: () => SharedConfig.data !== null,
    subscribe(listener: (key: keyof Settings) => void) {listeners.add(listener); return () => {listeners.delete(listener);};}};
}
export type SettingsService = ReturnType<typeof createSettings>;
