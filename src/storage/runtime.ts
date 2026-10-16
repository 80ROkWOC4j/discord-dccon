import type {StorageEnvironment, StorageFilesystem} from './types.ts';

// Node and BetterDiscord expose different filesystem implementations. Keep the
// host modules explicit so neither browser imports nor hidden require shims are needed.
export function createStorageEnvironment(modules: {
  path: typeof import('node:path');
  crypto: Pick<typeof import('node:crypto'), 'createHash' | 'randomBytes'>;
  fs: Pick<typeof import('node:fs'), 'promises' | 'createReadStream'>;
}): StorageEnvironment {
  const {path, crypto, fs} = modules;
  return {
    path, fs: fs.promises as StorageFilesystem,
    digest: value => crypto.createHash('sha256').update(value).digest('hex'),
    randomToken: () => crypto.randomBytes(16).toString('hex'),
    async hashFile(file) {
      const hash = crypto.createHash('sha256');
      for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
      return hash.digest('hex');
    },
    ownerAlive(pid) {
      if (typeof process === 'undefined' || (process as NodeJS.Process & {isWeb?: boolean}).isWeb) return null;
      try {process.kill(pid, 0); return true;}
      catch (error) {return (error as NodeJS.ErrnoException).code !== 'ESRCH';}
    },
    pid: typeof process === 'undefined' ? 0 : process.pid,
  };
}
