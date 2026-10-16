import type {NativeBridge, Platform} from './types.ts';
type Bridge = Omit<NativeBridge, 'config'>;

// Only used when evaluating the existing shared-storage module in the browser.
export function createNativeRequire(native: Bridge) {
  const fs = Object.fromEntries(['readFile', 'writeFile', 'mkdir', 'rename', 'unlink'].map(method => [method, (...args: any[]) => {
    const callback = args.pop();
    native.file(method, args).then(value => callback(null, value), error => callback(error));
  }]));
  return (name: string): any => {
    if (name === 'fs') return fs;
    if (name === 'path') return {join: (...parts: string[]) => parts.join('/'), dirname: (value: string) => value.slice(0, value.lastIndexOf('/'))};
    if (name === 'crypto') return {createHash: (algorithm: string) => {
      if (algorithm !== 'sha256') throw Error('Only SHA-256 is supported');
      const chunks: (string | Uint8Array)[] = [];
      const hash = {update(value: string | Uint8Array) {chunks.push(value); return hash;}, digest: (encoding: string) => native.hash(chunks, encoding)};
      return hash;
    }};
    throw Error(`Unsupported native module: ${name}`);
  };
}
export function createNativeServices(native: Bridge, cacheRoot = '/cache') {
  const requestScope = globalThis.crypto.randomUUID(), activeRequests = new Set<string>();
  let requestId = 0, disposed = false;
  const fetchNative: Platform['net']['fetch'] = async (url, options = {}) => {
    const id = `${requestScope}:${++requestId}`, {signal, ...rest} = options;
    if (disposed || signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    activeRequests.add(id);
    const pending = native.fetch(id, url, rest);
    const abort = () => native.abort(id);
    signal?.addEventListener('abort', abort, {once: true});
    try {
      const response = await pending;
      const bytes = new Uint8Array(response.bytes);
      return {status: response.status, ok: response.status >= 200 && response.status < 300,
        headers: new Headers(response.headers), arrayBuffer: async () => bytes.buffer,
        text: async () => new TextDecoder().decode(bytes)};
    } finally {activeRequests.delete(id); signal?.removeEventListener('abort', abort);}
  };
  const net: Platform['net'] = {fetch: fetchNative};
  if (native.hostMod === 'vencord') net.resolveImage = async (source, signal) => {
    const url = new URL(source);
    const direct = url.origin === 'https://dccon-proxy.minibox.workers.dev'
      ? 'https://dcimg5.dcinside.com/dccon.php?no=' + encodeURIComponent(url.searchParams.get('no') || '') : source;
    const response = await fetchNative(direct, {signal, headers: {Referer: 'https://dcimg5.dcinside.com'}});
    if (!response.ok) throw Error('디시콘 미리보기를 다운로드하지 못했습니다.');
    return new Blob([await response.arrayBuffer()], {type: response.headers.get('content-type') || 'image/gif'});
  };
  const paths: Platform['paths'] = {
    join: (...parts) => parts.join('/'), dirname: value => value.slice(0, value.lastIndexOf('/')),
    cache: (...parts) => [cacheRoot, ...parts].join('/'),
    legacyCache: (...parts) => ['/dccon', 'discord-dccon-cache', ...parts].join('/'),
    dataRoot: () => '/dccon',
  };
  return {net, paths,
    async file(method: string, ...args: unknown[]) {
      try {return await native.file(method, args);}
      catch (error) {
        const failure = error as Error & {code?: string};
        if (!failure.code) {
          const code = /(?:^|Error: )(E[A-Z0-9]+):/.exec(failure.message)?.[1];
          if (code) failure.code = code;
        }
        throw error;
      }
    },
    sha256: (bytes: string | Uint8Array) => native.hash([bytes], 'hex'),
    readClipboardText: () => native.readClipboardText(),
    dispose() {
      disposed = true;
      for (const id of activeRequests) native.abort(id);
      activeRequests.clear();
    },
  };
}
