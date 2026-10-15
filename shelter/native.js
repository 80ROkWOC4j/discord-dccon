const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function channelOptions(channel = 'Stable') {
  if (channel === 'Stable') return {origin: 'https://discord.com', directory: 'discord-dccon'};
  if (channel === 'PTB') return {origin: 'https://ptb.discord.com', directory: 'discord-dccon-ptb'};
  if (channel === 'Canary') return {origin: 'https://canary.discord.com', directory: 'discord-dccon-canary'};
  throw Error('Unsupported Discord channel');
}

function prepareDataRoot(appData, channel = 'Stable') {
  const syncFs = require('node:fs');
  const root = path.join(appData, channelOptions(channel).directory);
  syncFs.mkdirSync(root, {recursive: true});
  return root;
}

function resolveFile(root, value) {
  if (typeof value !== 'string' || !value.startsWith('/dccon/')) throw Error('Invalid cache path');
  const result = path.resolve(root, value.slice('/dccon/'.length));
  const relative = path.relative(root, result);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Cache path escapes data directory');
  return result;
}
function createFiles(root, legacyRoot) {
  return async function file(method, args) {
    const [name, ...rest] = args;
    const resolved = resolveFile(root, name);
    switch (method) {
      case 'readFile':
        try {return await fs.readFile(resolved, ...rest);}
        catch (error) {
          // Imported BD data can refer to its cache or saved personal images; both stay read-only.
          if (error.code !== 'ENOENT' || !legacyRoot ||
              !(name.startsWith('/dccon/discord-dccon-cache/') || /^\/dccon\/discord-dccon-library\/[a-f0-9]{64}$/.test(name))) throw error;
          return fs.readFile(resolveFile(legacyRoot, name), ...rest);
        }
      case 'unlink':
        if (!/^\/dccon\/discord-dccon-library\/[a-f0-9]{64}$/.test(name)) throw Error('Invalid personal image path');
        try {return await fs.unlink(resolved);}
        catch (error) {if (error.code !== 'ENOENT') throw error;}
        return;
      case 'writeFile': return fs.writeFile(resolved, ...rest);
      case 'mkdir': return fs.mkdir(resolved, ...rest);
      case 'rename': return fs.rename(resolved, resolveFile(root, rest[0]));
      default: throw Error('Unsupported filesystem operation');
    }
  };
}
function allowedDownload(value) {
  const url = new URL(value);
  const hosts = ['dcinside.com', 'huggingface.co', 'hf.co', 'xethub.hf.co', 'cdn.jsdelivr.net', 'ac.arca.live'];
  if (url.protocol !== 'https:' || url.username || url.password ||
      !hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw Error('Unsupported download host');
  return url.href;
}
// net.fetch rejects manual redirects in Electron instead of returning the 3xx response.
function download(net, input, options = {}, signal) {
  return new Promise((resolve, reject) => {
    let url = allowedDownload(input), redirects = 0, settled = false;
    const method = options.method || 'GET';
    if (!['GET', 'POST'].includes(method)) throw Error('Unsupported download method');
    if (signal?.aborted) throw Error('Download aborted');
    const request = net.request({url, method, redirect: 'manual', credentials: 'omit'});
    const headers = values => Object.entries(values).flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).map(item => [key, item]));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => {finish(Error('Download aborted')); request.abort();};
    request.on('error', error => finish(error));
    request.on('abort', () => finish(Error('Download aborted')));
    request.on('redirect', (status, nextMethod, target, responseHeaders) => {
      try {
        url = allowedDownload(new URL(target, url).href);
        if (options.redirect === 'manual') {
          finish(null, {status, headers: headers(responseHeaders), bytes: new Uint8Array()});
          request.abort();
        } else {
          if (++redirects > 8) throw Error('Too many redirects');
          request.followRedirect();
        }
      } catch (error) {finish(error); request.abort();}
    });
    request.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', error => finish(error));
      response.on('aborted', () => finish(Error('Download aborted')));
      response.on('end', () => finish(null, {status: response.statusCode,
        headers: headers(response.headers), bytes: new Uint8Array(Buffer.concat(chunks))}));
      response.on('close', () => finish(Error('Download closed before completion')));
    });
    signal?.addEventListener('abort', abort, {once: true});
    try {
      for (const [name, value] of Object.entries(options.headers || {})) request.setHeader(name, value);
      request.end(options.body);
    } catch (error) {finish(error); request.abort();}
  });
}
function hash(chunks, encoding) {
  if (encoding !== 'hex') throw Error('Only hex digest is supported');
  const result = crypto.createHash('sha256');
  for (const chunk of chunks) result.update(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
  return result.digest('hex');
}
module.exports = {download, createFiles, resolveFile, allowedDownload, hash, prepareDataRoot, channelOptions};
