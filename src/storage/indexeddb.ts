import {mergeSetting} from './merge.ts';
import type {Configuration, Settings} from './types.ts';

// IndexedDB serializes read/write transactions across tabs. Merge only the
// requested setting against the current record using the shared desktop policy.
export function createConfig(indexedDB: IDBFactory) {
  let opening: Promise<IDBDatabase> | undefined, disposed = false;
  function database() {
    if (disposed) return Promise.reject(Error('Settings are closed'));
    return opening ||= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('discord-dccon-userscript-settings', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('config');
      request.onerror = () => {opening = undefined; reject(request.error);};
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {db.close(); opening = undefined;};
        if (disposed) {db.close(); reject(Error('Settings are closed'));} else resolve(db);
      };
    });
  }
  async function config(method: 'open' | 'save', args: unknown[]): Promise<Configuration> {
    if (!['open', 'save'].includes(method)) throw Error('Unsupported settings operation');
    if (method === 'save' && (typeof args[0] !== 'string' || ['__proto__','constructor','prototype'].includes(args[0]))) throw Error('Invalid setting key');
    const db = await database();
    return new Promise<Configuration>((resolve, reject) => {
      const tx = db.transaction('config', 'readwrite'), store = tx.objectStore('config');
      let result: Configuration, failure: unknown;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(failure || tx.error || Error('Settings transaction failed'));
      const read = store.get('current');
      read.onsuccess = () => {
        try {
          result = read.result || {version:1, settings:structuredClone(method === 'open' ? args[0] as Settings || {} : {})};
          if (result.version !== 1) throw Error('Unsupported settings version');
          if (method === 'save') {
            const [key, value, before] = args as [string, unknown, unknown];
            result.settings[key] = mergeSetting(key, before, value, result.settings[key]);
          }
          if (!read.result || method === 'save') store.put(result, 'current');
        } catch (error) {failure = error; tx.abort();}
      };
    });
  }
  return {config, dispose() {disposed = true; opening?.then(db => db.close(), () => {});}};
}
