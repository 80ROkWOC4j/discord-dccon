// Test entrypoint imports the same modules as production. Bundling supplies
// isolated browser globals to legacy VM/Chromium fixtures without source slicing.
import {createServices, createUI, createPluginClass} from '../../src/core/plugin.ts';
import {createBetterDiscordPlatform, appDataDirectory} from '../../src/platform/betterdiscord.ts';
import {isWebP, webpFile} from '../../src/core/codecs.ts';
import {readEmbeddingVectors} from '../../src/core/embedding.ts';
import type {Platform} from '../../src/platform/types.ts';
import type {Images} from '../../src/core/images.ts';
export {createBetterDiscordPlatform};
export {createMediaUI} from '../../src/core/ui/media.ts';
export {mountToolbar} from '../../src/core/ui/toolbar.ts';
export function createHarness(platform: Platform, assets: {splitWorkerSource: string; styles: string}) {
  const services = createServices(platform, assets);
  const ui = createUI(platform, services);
  const {settings, packs, cache, codecs, images, sending, personal, embedding, events} = services;
  const Plugin = createPluginClass(platform, assets, services, ui);
  return {
    services, platform, Plugin, ...ui.media, ...ui.picker, ...ui.management, ...ui.toolbar,
    ...cache, ...packs, ...personal, ...sending,
    ...images, loadData: settings.loadData, saveData: settings.saveData,
    SharedConfig: settings, WebPCache: codecs, Embedding: embedding, events,
    isWebP, webpFile, readEmbeddingVectors,
    appDataDirectory: (os: string, env: Record<string, string>, home: string) => appDataDirectory(os, env, home, platform.paths.join),
    setChannel: sending.setCurrentChannel,
    getChannel: sending.getCurrentChannel,
    setImageLoader: (loader: Images['getDCConImage']) => {images.getDCConImage = loader;},
    setAnimationTiming: (timing: Images['animationTiming']) => {images.animationTiming = timing;},
    setMergeForTest: (merge: Images['mergeAnimatedImages']) => {images.mergeAnimatedImages = merge;},
    setSplitForTest: (split: Images['splitImageIntoNine']) => {images.splitImageIntoNine = split;},
  };
}
