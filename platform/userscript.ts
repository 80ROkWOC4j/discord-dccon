import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import {createUserscriptNative} from '../userscript/native.js';
import {createComposerBridge} from '../userscript/composer.js';
import {createConfig} from '../userscript/config.js';
import {createNativeRequire, createNativeServices} from './native.ts';
import {createLocaleStore} from './locale.ts';
import type {Composer, Configuration, NativeBridge, Platform, PlatformHandle, Settings} from './types.ts';

export function createUserscriptPlatform({page, request, load, storageSource}: {
  page: Window & typeof globalThis;
  request: Parameters<typeof createUserscriptNative>[0];
  load(key: string, fallback: unknown): unknown;
  storageSource: string;
}): PlatformHandle {
  const native = createUserscriptNative(request);
  const bridge = native as Omit<NativeBridge, 'config'>;
  const services = createNativeServices(bridge, '/dccon/cache');
  const initialData = load('data', {dccons: load('packs', [])}) as Settings;
  const shared = {exports: {} as {mergeSetting: Parameters<typeof createConfig>[1]}};
  new Function('require', 'module', storageSource)(createNativeRequire(bridge), shared);
  const settings = createConfig(page.indexedDB, shared.exports.mergeSetting);
  const config: Configuration = {
    open: () => settings.config('open', [initialData]) as ReturnType<Configuration['open']>,
    save: (...args) => settings.config('save', args) as ReturnType<Configuration['save']>,
  };
  const composer = createComposerBridge(page, document) as Composer & {dispose(): void};
  const channelId = () => location.pathname.match(/^\/channels\/[^/]+\/(\d+)$/)?.[1];
  const toasts = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const styles = new Map<string, HTMLStyleElement>();
  const locale = createLocaleStore();
  const platform: Platform = {
    react: React, reactDOM: {...ReactDOM, createRoot: ReactDOMClient.createRoot},
    discord: {
      locale: locale.store,
      classes: {icon: {}, textarea: {}},
      selectedChannelStore: () => ({getChannelId: channelId,
        addChangeListener: listener => window.addEventListener('popstate', listener),
        removeChangeListener: listener => window.removeEventListener('popstate', listener)}),
      channelFor: channelId, uploadModule: () => undefined, restModule: () => undefined, inspect: () => ({}),
    },
    net: {...services.net, resolveImage: native.resolveImage}, paths: services.paths, file: services.file,
    sha256: services.sha256, readClipboardText: services.readClipboardText,
    cacheAvailable: () => true, config, createConfig: () => config,
    data: {load: key => initialData?.[key] === undefined ? undefined : JSON.parse(JSON.stringify(initialData[key]))},
    composer,
    logger: {error: (...args) => console.error('[discord-dccon shelter]', ...args)},
    ui: {showToast(content, options = {}) {
      const toast = document.createElement('div'); toast.textContent = content; toast.setAttribute('role', 'status');
      toast.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);z-index:10001;padding:12px;background:#222;color:#fff;border-radius:8px;max-width:80vw';
      document.body.append(toast);
      toasts.set(toast, setTimeout(() => {toast.remove(); toasts.delete(toast);}, options.timeout || 4000));
    }},
    styles: {
      add(id, css) {
        platform.styles.remove(id);
        const style = document.createElement('style'); style.textContent = css; document.head.append(style); styles.set(id, style);
      },
      remove(id) {styles.get(id)?.remove(); styles.delete(id);},
    },
  };
  return {platform, dispose() {
    services.dispose(); native.dispose(); settings.dispose(); composer.dispose();
    locale.dispose();
    for (const id of styles.keys()) platform.styles.remove(id);
    for (const [toast, timer] of toasts) {clearTimeout(timer); toast.remove();}
    toasts.clear();
  }};
}
