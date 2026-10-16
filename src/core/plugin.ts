import type {Platform} from '../platform/types.ts';
import type {PluginMeta, Failure} from './types.ts';
import {createEvents} from './events.ts';
import {createCache} from './cache.ts';
import {createSettings} from './settings.ts';
import {createPacks} from './packs.ts';
import {createCodecs} from './codecs.ts';
import {createImages} from './images.ts';
import {createSending} from './sending.ts';
import {createPersonal} from './personal.ts';
import {createEmbedding, EMBEDDING_SPEC} from './embedding.ts';
import {getLocaleStrings as stringsFor} from './strings.ts';
import {createMediaUI} from './ui/media.ts';
import {createPickerUI} from './ui/picker.ts';
import {createSettingsUI} from './ui/settings.ts';
import {createToolbarUI} from './ui/toolbar.ts';

export interface PluginAssets {splitWorkerSource: string; styles: string}
export function createServices(platform: Platform, assets: Pick<PluginAssets, 'splitWorkerSource'>) {
  const events = createEvents();
  const settings = createSettings(platform, EMBEDDING_SPEC);
  const cache = createCache(platform);
  const codecs = createCodecs(platform, cache, assets.splitWorkerSource);
  const images = createImages(platform, cache, codecs);
  const packs = createPacks(platform, settings, images, events);
  const sending = createSending(platform, settings, images, events);
  const personal = createPersonal(platform, settings, packs, cache, codecs, sending, events);
  const embedding = createEmbedding(platform, settings, cache, packs, images, events);
  let unsubscribe: (() => void) | undefined;
  function connect() {
    unsubscribe ??= settings.subscribe(key => {
      if ((key === 'dccons' || key === 'personalCons') && embedding.enabled()) void embedding.index();
    });
  }
  function disconnect() {unsubscribe?.(); unsubscribe = undefined;}
  connect();
  return {events, settings, cache, packs, codecs, images, sending, personal, embedding, connect, disconnect};
}
export function createUI(platform: Platform, services: ReturnType<typeof createServices>) {
  const {settings, packs, images, sending, personal, embedding, events} = services;
  const media = createMediaUI(platform, images);
  const picker = createPickerUI(platform, {settings, packs, images, sending, embedding, events, media});
  const management = createSettingsUI(platform, {packs, personal, sending, embedding, events, media});
  const toolbar = createToolbarUI(platform, sending, events, media, picker, management);
  return {media, picker, management, toolbar};
}
export function createPlugin(platform: Platform, assets: PluginAssets) {
  const services = createServices(platform, assets);
  return createPluginClass(platform, assets, services, createUI(platform, services));
}
export function createPluginClass(platform: Platform, assets: PluginAssets, services: ReturnType<typeof createServices>, ui: ReturnType<typeof createUI>) {
  const {settings, images, sending, embedding: Embedding, codecs: WebPCache, events: PluginEvents, connect, disconnect, packs} = services;
  const {DCConSettingsPanel} = ui.management;
  const {toolbar} = ui;
  const LocaleStore = platform.discord.locale;
  const getLocaleStrings = () => stringsFor(LocaleStore);
  class DCCon {
    declare meta: PluginMeta;
    declare strings: ReturnType<typeof getLocaleStrings>;
    declare startGeneration: number;
    declare startError: Failure | null;
    declare startPromise?: Promise<void>;
    declare unmountToolbar: (() => void) | null;
    declare localeListener: (() => void) | null;
    constructor(meta: PluginMeta) {
      this.meta = meta;
      this.strings = getLocaleStrings();
      this.startGeneration = 0;
    }

    getSettingsPanel() {
      if (platform.cacheAvailable() && !settings.isReady())
        return platform.react.createElement("div", null, this.startError ? "설정 읽기 실패: " + this.startError.message : "공통 설정을 불러오는 중입니다.");
      return platform.react.createElement(DCConSettingsPanel, {section: "settings"});
    }

    start() {
      connect();
      const generation = ++this.startGeneration;
      this.startError = null;
      if (!platform.config && !platform.cacheAvailable()) return this.startReady();
      this.startPromise = (async () => {
        try {await settings.open();}
        catch (_error) { const error = _error as Failure;
          this.startError = error;
          platform.logger.error("discord-dccon", "Configuration migration failed", error);
          platform.ui.showToast("설정 이전 실패: " + error.message + " · 다음 시작에 재시도합니다.", {type: "error", timeout: 10000});
          return;
        }
        if (generation === this.startGeneration) this.startReady();
      })().catch(error => {
        platform.logger.error("discord-dccon", "Plugin startup failed", error);
        platform.ui.showToast("디시콘 시작 실패: " + error.message, {type: "error", timeout: 10000});
      });
      return this.startPromise;
    }

    startReady() {
      const repairedPacks = packs.initialize();
      images.warmCache(repairedPacks.flatMap(pack => pack.detail));
      if (Embedding.enabled()) void Embedding.start();
      this.unmountToolbar = toolbar.mountToolbar(toolbar.DCConButton);

      platform.styles.add(this.meta.name, this.css);

      // 언어 변경 리스너 추가
      this.localeListener = () => {this.strings = getLocaleStrings();};
      LocaleStore.addChangeListener(this.localeListener);
    }

    stop() {
      disconnect();
      this.startGeneration++;
      images.stop();
      sending.stop();
      if (this.localeListener) LocaleStore.removeChangeListener?.(this.localeListener);
      this.localeListener = null;
      Embedding.stop();
      WebPCache.stop();
      this.unmountToolbar?.();
      this.unmountToolbar = null;
      PluginEvents.dispatch({ type: "DCCON_UNPATCH_ALL" });
      platform.styles.remove(this.meta.name);
    }

    get css() { return assets.styles; }
  }
  return DCCon;
}
