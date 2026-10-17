// A small binary file store for the shared plugin's callback-based fs adapter.
function createBrowserFiles(indexedDB, name = 'discord-dccon-files') {
  let opening, disposed = false;
  function database() {
    if (disposed) return Promise.reject(Error('Storage is closed'));
    return opening ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onerror = () => {opening = undefined; reject(request.error);};
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {db.close(); opening = undefined;};
        if (disposed) {db.close(); reject(Error('Storage is closed'));}
        else resolve(db);
      };
    });
  }
  function key(value) {
    if (typeof value !== 'string' || !value.startsWith('/dccon/') || value.split('/').some(part => part === '..' || part === '.'))
      throw Error('Invalid cache path');
    return value;
  }
  async function file(method, args) {
    const [name, value] = args, source = key(name);
    if (method === 'mkdir') return;
    if (!['readFile', 'writeFile', 'rename', 'unlink'].includes(method)) throw Error('Unsupported filesystem operation');
    const destination = method === 'rename' ? key(value) : undefined;
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('files', method === 'readFile' ? 'readonly' : 'readwrite');
      const store = transaction.objectStore('files');
      let result, failure;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = transaction.onerror = () => reject(failure || transaction.error || Error('Storage transaction failed'));
      if (method === 'writeFile') {
        store.put(typeof value === 'string' ? value : new Uint8Array(value), source);
      } else if (method === 'unlink') {
        store.delete(source);
      } else {
        const request = store.get(source);
        request.onsuccess = () => {
          if (request.result === undefined) {
            failure = Object.assign(Error('File not found'), {code: 'ENOENT'});
            transaction.abort();
          } else if (method === 'rename') {
            store.put(request.result, destination);
            store.delete(source);
          } else {
            const data = request.result;
            result = value === 'utf8' || value === 'utf-8'
              ? typeof data === 'string' ? data : new TextDecoder().decode(data)
              : typeof data === 'string' ? new TextEncoder().encode(data) : data;
          }
        };
      }
    });
  }
  return {file, dispose() {disposed = true; opening?.then(db => db.close(), () => {});}};
}
module.exports = {createBrowserFiles};
