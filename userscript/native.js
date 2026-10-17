const {sha256} = require('@noble/hashes/sha2.js');
const {createBrowserFiles} = require('./browser-files');

function createUserscriptNative(gmRequest, environment = globalThis) {
  const storage = createBrowserFiles(environment.indexedDB);
  const encoder = new TextEncoder();
  const requests = new Map();
  let disposed = false;
  function allowed(input) {
    const url = new URL(input);
    const hosts = ['dcinside.com', 'ac.arca.live', 'cdn.jsdelivr.net', 'huggingface.co', 'hf.co', 'xethub.hf.co'];
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !(url.hostname === 'api.github.com' || hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host)))) throw Error('Unsupported download host');
    return url;
  }
  const native = {
    initialData: {},
    file: storage.file,
    hash(chunks, encoding) {
      if (encoding !== 'hex') throw Error('Only hex digest is supported');
      const hash = sha256.create();
      for (const chunk of chunks) hash.update(typeof chunk === 'string' ? encoder.encode(chunk) : new Uint8Array(chunk));
      return [...hash.digest()].map(byte => byte.toString(16).padStart(2, '0')).join('');
    },
    readClipboardText: () => environment.navigator.clipboard.readText(),
    fetch(id, input, options = {}) {
      if (disposed) return Promise.reject(Error('Downloads are stopped'));
      return new Promise((resolve, reject) => {
        const url = allowed(input);
        const method = options.method || 'GET';
        if (!['GET', 'POST'].includes(method)) throw Error('Unsupported download method');
        const headers = {};
        for (const [key, value] of Object.entries(options.headers || {}))
          if (['accept', 'content-type', 'x-requested-with', 'referer'].includes(key.toLowerCase())) headers[key] = value;
        let finished = false;
        const finish = (error, value) => {
          if (finished) return;
          finished = true; requests.delete(id);
          error ? reject(error) : resolve(value);
        };
        const control = gmRequest({url: url.href, method, headers, data: options.body,
          responseType: 'arraybuffer', anonymous: true, timeout: 120000,
          onload(response) {
            try {
              allowed(response.finalUrl || url.href);
              const headers = response.responseHeaders.trim().split(/[\r\n]+/).flatMap(line => {
                const index = line.indexOf(':');
                const name = line.slice(0, index).trim().toLowerCase();
                // Firefox/GM can expose cookie continuations as separate lines.
                // The plugin only needs these public response headers.
                return index > 0 && ['content-type', 'content-length', 'location'].includes(name)
                  ? [[name, line.slice(index + 1).trim()]] : [];
              });
              finish(null, {status: response.status, headers, bytes: new Uint8Array(response.response)});
            } catch (error) {finish(error);}
          },
          onerror: () => finish(Error('디시콘 다운로드에 실패했습니다.')),
          ontimeout: () => finish(Error('다운로드 시간이 초과되었습니다.')),
          onabort: () => finish(new DOMException('Aborted', 'AbortError')),
        });
        if (!finished) requests.set(id, () => {control.abort(); finish(new DOMException('Aborted', 'AbortError'));});
      });
    },
    abort: id => requests.get(id)?.(),
    async resolveImage(source, signal) {
      const original = new URL(source);
      const image = original.origin === 'https://dccon-proxy.minibox.workers.dev'
        ? 'https://dcimg5.dcinside.com/dccon.php?no=' + encodeURIComponent(original.searchParams.get('no') || '') : source;
      const id = 'thumbnail:' + crypto.randomUUID();
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const abort = () => native.abort(id);
      signal?.addEventListener('abort', abort, {once: true});
      try {
        const response = await native.fetch(id, image, {headers: {Referer: 'https://dcimg5.dcinside.com'}});
        if (response.status >= 400) throw Error('Thumbnail download failed');
        return new Blob([response.bytes], {type: new Headers(response.headers).get('content-type') || 'image/gif'});
      } finally {signal?.removeEventListener('abort', abort);}
    },
    dispose() {
      disposed = true;
      for (const abort of [...requests.values()]) abort();
      requests.clear(); storage.dispose();
    },
  };
  return native;
}
module.exports = {createUserscriptNative};
