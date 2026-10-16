import type * as React from 'react';
import type * as ReactDOM from 'react-dom';
import type * as ReactDOMClient from 'react-dom/client';

export type Settings = Record<string, unknown>;
export interface ConfigurationSnapshot {
  settings: Settings;
  version?: number;
  error?: never;
}
export type ConfigurationResult = ConfigurationSnapshot | {
  error: {message: string; code?: string};
  settings?: never;
};
export interface Configuration {
  open(): Promise<ConfigurationResult>;
  save(key: string, value: unknown, before: unknown): Promise<ConfigurationResult>;
}
export interface DownloadOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  responseType?: string;
  redirect?: string;
}
export interface DownloadResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}
export interface Composer {
  targetFor(editor: Element): string | undefined;
  attachFiles(files: File[], target: string): Promise<void>;
  available?(): boolean;
}
export interface ChannelStore {
  getChannelId?(): string | undefined;
  addChangeListener?(listener: () => void): void;
  removeChangeListener?(listener: () => void): void;
}
// Discord's private exports have no stable upstream types. Keep this boundary
// explicit; the platform API exposes only the operations the plugin uses.
export type DiscordExport = any;
export interface ModuleLookup {
  getModule(filter: (value: DiscordExport) => boolean, options?: {searchExports?: boolean}): DiscordExport;
  getByKeys(...keys: string[]): DiscordExport;
  getStore?(name: string): DiscordExport;
  getModuleBySource?(filter: (value: DiscordExport) => boolean, source: string): DiscordExport;
}
export interface DiscordServices {
  locale: DiscordExport;
  classes: {icon: Record<string, string>; textarea: Record<string, string>};
  selectedChannelStore(): ChannelStore | undefined;
  channelFor(editor: Element): string | undefined;
  uploadModule(): DiscordExport;
  restModule(): DiscordExport;
  inspect(): Record<string, boolean | string>;
}
export interface Platform {
  react: typeof React;
  reactDOM: Pick<typeof ReactDOM, 'createPortal'> & Pick<typeof ReactDOMClient, 'createRoot'>;
  discord: DiscordServices;
  net: {fetch(url: string, options?: DownloadOptions): Promise<DownloadResponse>; resolveImage?(url: string, signal?: AbortSignal): Promise<Blob>};
  paths: {join(...parts: string[]): string; dirname(file: string): string; cache(...parts: string[]): string; legacyCache(...parts: string[]): string; dataRoot(): string};
  file(method: string, ...args: unknown[]): Promise<unknown>;
  sha256(input: string | Uint8Array): string;
  readClipboardText(): string | Promise<string>;
  cacheAvailable(): boolean;
  config?: Configuration;
  createConfig(vectorSpec: string): Configuration;
  data: {load(key: string): unknown; save?(key: string, value: unknown): unknown};
  composer?: Composer;
  logger: {error(...args: unknown[]): void};
  ui: {showToast(content: string, options?: {type?: string; timeout?: number}): void};
  styles: {add(id: string, css: string): void; remove(id: string): void};
}
export interface PlatformHandle {platform: Platform; dispose(): void}
export interface NativeBridge {
  hostMod?: string;
  file(method: string, args: unknown[]): Promise<unknown>;
  hash(chunks: (string | Uint8Array)[], encoding: string): string;
  readClipboardText(): string | Promise<string>;
  config(method: string, args: unknown[]): Promise<ConfigurationResult>;
  fetch(id: string, url: string, options: DownloadOptions): Promise<{status: number; headers: [string, string][]; bytes: Uint8Array | ArrayBuffer}>;
  abort(id: string): void;
}
