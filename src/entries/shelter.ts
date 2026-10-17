import styles from '../core/style.css';
import {createPlugin} from '../core/plugin.ts';
import {createShelterPlatform} from '../platform/shelter.ts';
import type {NativeBridge, ModuleLookup} from '../platform/types.ts';
type Host = Parameters<typeof createShelterPlatform>[0] & {
  plugin: {id: string; flushStore(): void};
  plugins: {stopPlugin(id: string): void; startPlugin(id: string): void; removePlugin(id: string): void};
};
export function createShelterPlugin(shelter: Host, DCConNative: NativeBridge | undefined,
  dcconWebpack: ModuleLookup & {isReady?(): boolean; storageRetried?: boolean}, dcconVersion: string) {
  let plugin: InstanceType<ReturnType<typeof createPlugin>> | undefined;
  let adapter: ReturnType<typeof createShelterPlatform> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, disposed = false;
  function stop() {
    disposed = true;
    clearTimeout(timer);
    try {plugin?.stop();} finally {adapter?.dispose();}
  }
  async function start() {
    if (disposed) return;
    if (!DCConNative) {
      // The native installer was removed. Shelter retains plugin data on removal.
      // Wait until startPlugin has finished registering this lifecycle instance.
      queueMicrotask(() => shelter.plugins.removePlugin(shelter.plugin.id));
      return;
    }
    if (typeof (globalThis as {BdApi?: unknown}).BdApi !== 'undefined') {
      console.error('[discord-dccon shelter] BetterDiscord 중복 실행 감지. 기존 로더를 확인하세요.');
      return;
    }
    const checks = {
      Webpack: dcconWebpack.isReady?.() !== false,
      React: !!shelter.React?.createElement,
      ReactDOM: !!shelter.ReactDOM?.createPortal,
      ReactDOMClient: !!shelter.ReactDOMClient?.createRoot,
      DiscordHTTP: !!shelter.http?._raw && ['get', 'post', 'put', 'del'].every(key => typeof shelter.http!._raw[key] === 'function'),
    };
    if (Object.values(checks).some(value => !value)) {
      // Channel modules may load only after login / opening a conversation.
      timer = setTimeout(start, 1000);
      return;
    }
    try {
      // This pinned shelter build returns a plain object when a plugin store is
      // first created (??= returns its RHS). Restart once to obtain its proxy.
      try {shelter.plugin.flushStore();}
      catch (caught) { const error = caught as Error;
        if (dcconWebpack.storageRetried || !error.message.includes('not a shelter storage proxy')) throw error;
        dcconWebpack.storageRetried = true;
        timer = setTimeout(() => {
          shelter.plugins.stopPlugin(shelter.plugin.id);
          shelter.plugins.startPlugin(shelter.plugin.id);
        }, 0);
        return;
      }
      adapter = createShelterPlatform(shelter, DCConNative, dcconWebpack);
      const Plugin = createPlugin(adapter.platform, {splitWorkerSource: __DCCON_SPLIT_WORKER__, styles});
      plugin = new Plugin({name: 'discord-dccon', version: dcconVersion});
      await plugin.start();
    } catch (caught) { const error = caught as Error;
      try {plugin?.stop();} finally {adapter?.dispose();}
      console.error('[discord-dccon shelter]', error);
      shelter.ui.showToast({title: 'discord-dccon 오류', content: error.message, duration: 15000});
    }
  }
  return {onLoad: start, onUnload: stop};
}
