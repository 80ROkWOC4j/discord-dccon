import type {Configuration, ModuleLookup, Platform} from './types.ts';
import {createDiscordServices} from './discord.ts';
import {createConfigStore} from '../storage/file-store.ts';
import {createStorageEnvironment} from '../storage/runtime.ts';
import type {StorageFilesystem} from '../storage/types.ts';

type NativeRequire = (name: string) => any;
interface BetterDiscord {
  React: Platform['react'];
  ReactDOM: Platform['reactDOM'];
  ReactUtils: {getInternalInstance(editor: Element): any};
  Webpack: ModuleLookup;
  Net: Platform['net'];
  Config?: Configuration;
  Composer?: Platform['composer'];
  Plugins: {folder?: string; cacheFolder?: string; dataFolder?: string};
  Data: {load(plugin: string, key: string): unknown; save(plugin: string, key: string, value: unknown): unknown};
  Logger: Platform['logger'];
  UI: Platform['ui'];
  DOM: {addStyle(id: string, css: string): void; removeStyle(id: string): void};
}
export function appDataDirectory(platform: string, env: Record<string, string | undefined>, home: string, join: (...parts: string[]) => string): string {
  if (platform === 'win32') return env.APPDATA || join(home, 'AppData', 'Roaming');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support');
  return join(home, '.config');
}
export function createBetterDiscordPlatform(api: BetterDiscord, nativeRequire: NativeRequire): Platform {
  const paths: Platform['paths'] = {
    join: (...parts) => nativeRequire('path').join(...parts),
    dirname: file => nativeRequire('path').dirname(file),
    cache(...parts) {
      if (api.Plugins.cacheFolder) return paths.join(api.Plugins.cacheFolder, ...parts);
      const runtime = globalThis.process || nativeRequire('process');
      return paths.join(appDataDirectory(runtime.platform, runtime.env, nativeRequire('os').homedir(), paths.join), 'discord-dccon', 'cache', ...parts);
    },
    legacyCache: (...parts) => paths.join(api.Plugins.folder!, 'discord-dccon-cache', ...parts),
    dataRoot: () => api.Plugins.dataFolder || paths.dirname(paths.cache()),
  };
  const file: Platform['file'] = (method, ...args) => new Promise((resolve, reject) => {
    nativeRequire('fs')[method](...args, (error: NodeJS.ErrnoException | null, value: unknown) => {
      if (!error) return resolve(value);
      if (!error.code) error.code = /(?:^|Error: )(E[A-Z0-9]+):/.exec(error.message)?.[1];
      reject(error);
    });
  });
  return {
    react: api.React, reactDOM: api.ReactDOM,
    discord: createDiscordServices(api.Webpack, editor => api.ReactUtils.getInternalInstance(editor)),
    get net() {return api.Net;}, paths, file,
    sha256: bytes => nativeRequire('crypto').createHash('sha256').update(bytes).digest('hex'),
    readClipboardText: () => nativeRequire('electron').clipboard.readText(),
    cacheAvailable: () => typeof nativeRequire === 'function' && !!api.Plugins?.folder,
    get config() {return api.Config;},
    createConfig(vectorSpec) {
      const filesystem = nativeRequire('fs');
      const fs = Object.fromEntries(['mkdir', 'rmdir', 'readdir', 'lstat', 'stat', 'realpath', 'readFile', 'writeFile', 'rename', 'unlink'].map(method =>
        [method, (...args: unknown[]) => typeof filesystem[method] === 'function' ? file(method, ...args)
          : Promise.resolve().then(() => filesystem[method + 'Sync'](...args))]));
      if (filesystem.realpathSync) fs.realpath = (file: unknown) => Promise.resolve().then(() => filesystem.realpathSync(file));
      const runtime = globalThis.process || nativeRequire('process');
      const environment = createStorageEnvironment({path: nativeRequire('path'), crypto: nativeRequire('crypto'), fs: filesystem});
      const store = createConfigStore({fs: fs as unknown as StorageFilesystem, root: paths.dataRoot(), vectorSpec,
        legacyPluginsRoot: api.Plugins.folder, pid: runtime.pid}, environment);
      return {open: () => store.open(Object.fromEntries(
        ['dccons', 'favorites', 'recent', 'personalCons', 'collapsedPacks', 'embeddingEnabled', 'dcconsBeforeDedup']
          .map(key => [key, api.Data.load('discord-dccon', key)]).filter(([, value]) => value !== undefined))),
        save: (...args) => store.save(...args)};
    },
    data: {load: key => api.Data.load('discord-dccon', key), save: (key, value) => api.Data.save('discord-dccon', key, value)},
    get composer() {return api.Composer;},
    get logger() {return api.Logger;}, get ui() {return api.UI;},
    styles: {add: (id, css) => api.DOM.addStyle(id, css), remove: id => api.DOM.removeStyle(id)},
  };
}
