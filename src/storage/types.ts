export type Settings = Record<string, unknown>;
export interface Configuration {version: number; settings: Settings}
export interface FileInfo {
  birthtimeMs: number; mtimeMs: number;
  isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean;
}
export interface StorageFilesystem {
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  readFile(file: string, encoding: null): Promise<Uint8Array>;
  writeFile(file: string, value: string | Uint8Array): Promise<unknown>;
  mkdir(file: string, options: {recursive: boolean}): Promise<unknown>;
  rmdir(file: string): Promise<unknown>;
  readdir(file: string): Promise<string[]>;
  lstat(file: string): Promise<FileInfo>;
  stat(file: string): Promise<FileInfo>;
  realpath(file: string): Promise<string>;
  rename(from: string, to: string): Promise<unknown>;
  unlink(file: string): Promise<unknown>;
  copyFile?(from: string, to: string): Promise<unknown>;
}
export interface StorageEnvironment {
  path: typeof import('node:path');
  fs: StorageFilesystem;
  digest(value: string | Uint8Array): string;
  randomToken(): string;
  hashFile(file: string): Promise<string>;
  ownerAlive(pid: number): boolean | null;
  pid: number;
}
export interface StoreOptions {
  root: string; vectorSpec: string; fs?: StorageFilesystem;
  latestVersion?: number; legacyRoots?: string[]; legacyPluginsRoot?: string;
  ownerAlive?(pid: number): boolean | null;
  sleep?(milliseconds: number): Promise<void>;
  waitMs?: number; pid?: number;
}
export interface MigrationContext {
  fs: StorageFilesystem; path: StorageEnvironment['path']; digest: StorageEnvironment['digest'];
  root: string; cacheRoot: string; token: string; sequence: number; options: StoreOptions; vectorSpec: string;
  verifyRealPaths: boolean; legacyRoots: string[];
  report: {moved: number; duplicates: number; archived: number; vectors: number};
  hashFile(file: string): Promise<string>;
}
export type Migrations = Record<number, (context: MigrationContext) => Promise<void>>;
export interface ConfigStore {
  open(preferred?: Settings): Promise<Configuration>;
  save(key: string, value: unknown, before: unknown): Promise<Configuration>;
}
