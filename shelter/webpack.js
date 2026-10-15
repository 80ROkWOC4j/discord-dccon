// Capture only modules Discord actually executes; never eagerly require its bundle.
function captureWebpack(target, externalRequire) {
  const modules = new Map();
  const factories = new Map();
  let requireModule;
  const wrapped = new WeakSet();
  function wrap(chunk) {
    for (const [id, factory] of Object.entries(chunk?.[1] || {})) {
      if (typeof factory !== 'function' || wrapped.has(factory)) continue;
      factories.set(id, factory);
      const replacement = function(module, ...args) {
        requireModule = args[1] || requireModule;
        const result = factory.call(this, module, ...args);
        modules.set(id, module);
        return result;
      };
      wrapped.add(replacement);
      chunk[1][id] = replacement;
    }
    return chunk;
  }
  // Preserve Vencord factory source and chunk hooks by reusing its runtime.
  if (!externalRequire) {
    const chunks = target.webpackChunkdiscord_app ||= [];
    chunks.forEach(wrap);
    let push = chunks.push;
    Object.defineProperty(chunks, 'push', {
      configurable: true,
      get() {
        // Webpack binds the previous push before replacing it. Keep that exact
        // function; following the mutable variable would recursively call itself.
        const previous = push;
        return function(...items) { return previous.apply(this, items.map(wrap)); };
      },
      set: value => { push = value; },
    });
  }
  const byKeys = (...keys) => value => value != null && keys.every(key => value[key] !== undefined);
  function getModule(filter) {
    if (externalRequire) requireModule = externalRequire();
    for (const module of [...modules.values(), ...Object.values(requireModule?.c || {})]) {
      const root = module.exports;
      const candidates = [root];
      if (root && (typeof root === 'object' || typeof root === 'function')) {
        // Discord's named exports are commonly minified. BdApi's key search also
        // needs these exports, even when callers omit searchExports.
        for (const key of Object.keys(root)) {
          try { candidates.push(root[key]); } catch { /* An uninitialized getter. */ }
        }
      }
      for (const value of candidates) {
        try { if (filter(value)) return value; } catch { /* Unrelated module. */ }
      }
    }
  }
  function getModuleBySource(filter, source) {
    const found = getModule(filter);
    if (found) return found;
    if (typeof requireModule !== 'function') return;
    // Upload code may be loaded but not executed until Discord's first upload.
    // Require only factories containing the requested upload API, never all modules.
    // The initial Discord bundle registers factories directly on require.m,
    // without passing through webpackChunkdiscord_app.push.
    const available = new Map([...Object.entries(requireModule.m || {}), ...factories]);
    for (const [id, factory] of available) {
      if (modules.has(id) || !factory.toString().includes(source)) continue;
      const exports = requireModule(id);
      if (!modules.has(id)) modules.set(id, {exports});
      const value = getModule(filter);
      if (value) return value;
    }
  }
  return {getModule, getModuleBySource, getByKeys: (...keys) => getModule(byKeys(...keys)), Filters: {byKeys}, count: () => modules.size,
    isReady: () => !externalRequire || typeof externalRequire() === 'function'};
}

// Ordinary shelter plugins may load after Discord. Ask the existing chunk
// runtime for require instead of wrapping factories or waiting for new chunks.
function findWebpackRequire(target, knownExport) {
  const existing = target.Vencord?.Webpack?.wreq;
  if (existing) return existing;
  if (!knownExport) return;
  let requireModule;
  target.webpackChunkdiscord_app?.push([
    ['discord-dccon-' + target.crypto.randomUUID()], {}, value => {
      // Several Discord runtimes share the chunk array. The last callback may
      // belong to a library; select the one exporting shelter's channel store.
      const lookup = captureWebpack(target, () => value);
      if (lookup.getModule(candidate => candidate === knownExport)) requireModule = value;
    },
  ]);
  return requireModule;
}
if (typeof module !== 'undefined') module.exports = {captureWebpack, findWebpackRequire};
