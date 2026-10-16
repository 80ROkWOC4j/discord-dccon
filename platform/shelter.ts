import type {DiscordExport, ModuleLookup, NativeBridge, Platform, PlatformHandle, Settings} from './types.ts';
import {createDiscordServices} from './discord.ts';
import {createNativeServices} from './native.ts';
import {createLocaleStore} from './locale.ts';

interface ShelterHost {
  React: Platform['react'];
  ReactDOM: Pick<Platform['reactDOM'], 'createPortal'>;
  ReactDOMClient: Pick<Platform['reactDOM'], 'createRoot'>;
  util: {getFiber(editor: Element): DiscordExport};
  flux: {storesFlat: Record<string, DiscordExport>};
  http?: {_raw?: DiscordExport};
  plugin: {store: {dcconData?: Settings}};
  ui: {ToastColors: Record<string, unknown>; injectCss(css: string): () => void;
    showToast(options: {title: string; content: string; duration: number; color: unknown}): void};
}
export function createShelterPlatform(shelter: ShelterHost, native: NativeBridge, webpack: ModuleLookup): PlatformHandle {
  const styles = new Map<string, () => void>();
  const clone = <T>(value: T): T => value === undefined ? undefined as T : JSON.parse(JSON.stringify(value));
  const store = shelter.plugin.store;
  const locale = createLocaleStore();
  const services = createNativeServices(native);
  const modules: ModuleLookup = {
    getModule(filter, options) {
      const rest = shelter.http?._raw;
      if (rest && filter(rest)) return rest;
      if (filter.toString().includes('trackUploadFinished')) return webpack.getModuleBySource!(filter, 'trackUploadFinished');
      return webpack.getModule(filter, options);
    },
    getByKeys(...keys) {
      const signature = keys.join(',');
      if (signature === 'locale,initialize') return locale.store;
      if (signature === 'icon,active,buttonWrapper' || signature === 'channelTextArea,buttonContainer,button') return {};
      return webpack.getByKeys(...keys);
    },
    getStore: name => shelter.flux.storesFlat[name],
  };
  const config = {
    open: () => native.config('open', [clone(store.dcconData || {})]),
    save: (key: string, value: unknown, before: unknown) => native.config('save', [key, value, before]),
  };
  const platform: Platform = {
    react: shelter.React,
    reactDOM: {...shelter.ReactDOM, createRoot: (...args) => shelter.ReactDOMClient.createRoot(...args)},
    discord: createDiscordServices(modules, editor => shelter.util.getFiber(editor)),
    net: services.net, paths: services.paths, file: services.file,
    sha256: services.sha256, readClipboardText: services.readClipboardText,
    cacheAvailable: () => true, config, createConfig: () => config,
    data: {load: key => clone(store.dcconData?.[key])},
    logger: {error: (...args) => console.error('[discord-dccon shelter]', ...args)},
    ui: {showToast: (content, options = {}) => shelter.ui.showToast({title: 'discord-dccon', content,
      duration: options.timeout || 4000,
      color: shelter.ui.ToastColors[options.type === 'error' ? 'CRITICAL' : options.type === 'success' ? 'SUCCESS' : 'INFO']})},
    styles: {
      add(id, css) {platform.styles.remove(id); styles.set(id, shelter.ui.injectCss(css));},
      remove(id) {styles.get(id)?.(); styles.delete(id);},
    },
  };
  return {platform, dispose() {
    services.dispose(); locale.dispose();
    for (const id of styles.keys()) platform.styles.remove(id);
  }};
}
