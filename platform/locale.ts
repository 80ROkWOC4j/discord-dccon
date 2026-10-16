export function createLocaleStore() {
  const localeListeners = new Set<() => void>();
  let localeObserver: MutationObserver | undefined;
  const localeStore = {
    get locale() {return document.documentElement.lang || navigator.language || 'en';},
    initialize() {},
    addChangeListener(listener: () => void) {
      localeListeners.add(listener);
      if (!localeObserver) {
        localeObserver = new MutationObserver(() => {for (const notify of localeListeners) notify();});
        localeObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['lang']});
      }
    },
    removeChangeListener(listener: () => void) {
      localeListeners.delete(listener);
      if (!localeListeners.size) {localeObserver?.disconnect(); localeObserver = undefined;}
    },
  };
  return {store: localeStore, dispose() {localeObserver?.disconnect(); localeListeners.clear();}};
}
