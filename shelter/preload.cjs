const {ipcRenderer, contextBridge, webFrame, clipboard} = require('electron');
const {createFiles, hash} = require('./native');
const config = ipcRenderer.sendSync('dccon:init');
if (config && process.isMainFrame && location.origin === config.origin) {
  contextBridge.exposeInMainWorld('DCConNative', {
    hostMod: config.hostMod,
    file: createFiles(config.dataRoot, config.legacyRoot, config.cacheRoot),
    hash,
    config: (method, args) => ipcRenderer.invoke('dccon:config', method, args),
    readClipboardText: () => clipboard.readText(),
    fetch: (id, url, options) => ipcRenderer.invoke('dccon:fetch', id, url, options),
    abort: id => ipcRenderer.send('dccon:abort', id),
  });
  // Run before Discord's scripts: shelter observes React/Flux initialization.
  webFrame.executeJavaScript(config.bundle).catch(error => {
    console.error('[discord-dccon shelter] bootstrap failed', error);
  });
}
if (config?.originalPreload) require(config.originalPreload);
