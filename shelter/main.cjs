// discord-dccon injector. Does not change Discord's update endpoints or install updates.
const electron = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {download, prepareDataRoot, channelOptions} = require('./native');
const {createConfigStore} = require('./shared-storage.cjs');
const {app, ipcMain, net} = electron;
let channel = 'Stable', hostMod;
try {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'channel.json'), 'utf8'));
  channel = config.channel || 'Stable';
  hostMod = config.hostMod;
}
catch (error) {if (error.code !== 'ENOENT') throw error;}
if (hostMod !== undefined && hostMod !== 'vencord') throw Error('Unsupported host mod');
const {origin} = channelOptions(channel);
const dataRoot = prepareDataRoot(require('node:process').platform === 'linux'
  ? path.join(app.getPath('home'), '.config') : app.getPath('appData'), channel);
const cacheRoot = path.join(dataRoot, 'cache');
const configStore = createConfigStore({root: dataRoot, vectorSpec: 'q8-image560-video6x280-v2'});
const requests = new Map(), preloads = new Map();
const bundle = fs.readFileSync(path.join(__dirname, 'bootstrap.js'), 'utf8');
function trusted(event) {
  const url = new URL(event.senderFrame?.url || 'about:blank');
  if (event.senderFrame !== event.sender.mainFrame || url.origin !== origin) throw Error('Untrusted IPC origin');
}
ipcMain.on('dccon:init', event => {
  if (!preloads.has(event.sender.id)) {event.returnValue = null; return;}
  const legacyRoot = path.join(app.getPath('appData'), 'BetterDiscord', 'plugins');
  event.returnValue = {bundle, origin, dataRoot, cacheRoot, legacyRoot, hostMod, originalPreload: preloads.get(event.sender.id)};
});
ipcMain.on('dccon:abort', (event, id) => {
  trusted(event);
  requests.get(`${event.sender.id}:${id}`)?.abort();
});
ipcMain.handle('dccon:config', async (event, method, args) => {
  trusted(event);
  if (!['open', 'save'].includes(method)) throw Error('Invalid configuration operation');
  try {return await configStore[method](...args);}
  catch (error) {return {error: {message: error.message, code: error.code}};}
});
ipcMain.handle('dccon:fetch', async (event, id, input, options) => {
  trusted(event);
  const key = `${event.sender.id}:${id}`, controller = new AbortController();
  requests.set(key, controller);
  try {
    return await download(net, input, options, controller.signal);
  } finally {requests.delete(key);}
});

const BrowserWindow = new Proxy(electron.BrowserWindow, {
  construct(Target, args) {
    const options = args[0];
    const originalPreload = options?.webPreferences?.preload;
    if (originalPreload && options.title) {
      options.webPreferences = {...options.webPreferences, preload: path.join(__dirname, 'preload.cjs'),
        sandbox: false, contextIsolation: true, nodeIntegration: false};
    }
    const window = new Target(...args);
    if (originalPreload && options.title) {
      preloads.set(window.webContents.id, originalPreload);
      const id = window.webContents.id;
      window.webContents.once('destroyed', () => {
        preloads.delete(id);
        for (const [key, controller] of requests) if (key.startsWith(id + ':')) controller.abort();
      });
    }
    return window;
  },
});
// Electron can expose exports through a getter; an assignment may silently fail.
Object.defineProperty(require.cache[require.resolve('electron')], 'exports', {
  configurable: true, writable: true, value: {...electron, BrowserWindow},
});
function installHeaders() {
  electron.session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders;
    if (details.resourceType === 'mainFrame' && new URL(details.url).origin === origin) {
      // Keep Discord's CSP except for local evaluation and the existing blob Worker.
      for (const key of Object.keys(headers || {})) if (key.toLowerCase() === 'content-security-policy') {
        headers[key] = headers[key].map(value => value.split(';').map(part => {
          const directive = part.trim();
          if (/^(script-src|worker-src)\s/.test(directive)) return directive + " blob: 'unsafe-eval'";
          if (/^img-src\s/.test(directive)) return directive + ' https://*.dcinside.com https://dccon-proxy.minibox.workers.dev';
          return directive;
        }).join('; '));
      }
    }
    callback({responseHeaders: headers});
  });
}
// The macOS desktop-core entry is loaded after Electron's ready event.
// Vencord owns this single-listener Electron hook; registering here would
// replace its CSP. The adapter downloads thumbnail bytes and uses Blob URLs.
if (hostMod !== 'vencord') {
  if (app.isReady()) installHeaders();
  else app.on('ready', installHeaders);
}
