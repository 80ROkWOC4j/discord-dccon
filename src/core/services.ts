import type {Configuration, ConfigurationSnapshot} from '../platform/types.ts';
import type {Con, Settings, FileSystem, SearchResult} from './types.ts';
export type Binary = Uint8Array<ArrayBuffer>;
export type VectorMap = Record<string, number[]>;
export interface PendingSetting {key: keyof Settings; value: Settings[keyof Settings]; before: Settings[keyof Settings] | undefined}
export interface SharedConfiguration {
  data: Partial<Settings> | null; backend: Configuration | null; pending: PendingSetting[]; work: Promise<unknown>;
  open(): Promise<void>;
  call(method: 'open'): Promise<ConfigurationSnapshot>;
  call(method: 'save', key: string, value: unknown, before: unknown): Promise<ConfigurationSnapshot>;
  save<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>;
}
export interface Frame {bytes: Binary; duration: number}
export interface CodecRuntime {source: string; wasm: Binary}
export interface CodecSpec {source?: string; wasmURL?: string; name?: string; version?: string; hashes: (string | null)[]}
export type CodecKind = 'split' | 'gif' | 'img';
export interface WebPService {
  generation: number; work: Promise<unknown>; assets: Map<CodecKind, Promise<CodecRuntime>>; downloads: Set<AbortController>;
  specs: Record<CodecKind, CodecSpec>; worker?: Worker | null; splitWorker?: Worker | null; workerKinds?: Set<CodecKind>;
  reject?: ((error: Error) => void) | null;
  runtime(kind: CodecKind, generation: number): Promise<CodecRuntime>;
  workerMain(): void;
  convert(bytes: Binary, frames?: Frame[], loopCount?: number): Promise<Binary>;
  split(bytes: Binary | null, images?: Binary[]): Promise<ArrayBuffer | ArrayBuffer[]>;
  merge(images: Binary[]): Promise<ArrayBuffer>;
  stop(): void;
}
export interface EmbeddingStatus {phase: string; completed: number; total: number; errors: number; file?: string; error?: string}
export interface EmbeddingArguments {bytes?: ArrayBuffer; wasm?: ArrayBuffer; type?: string; text?: string; library?: string; factory?: string}
export type EmbeddingResult = number[] | {device: string};
export interface EmbeddingService {
  worker: Worker | null; generation: number; sequence: number;
  pending: Map<number, {resolve(value: EmbeddingResult): void; reject(error: Error): void}>;
  vectors: VectorMap; legacyVectors: VectorMap; dirtyVectors: number; urls: string[];
  assetRequests: Map<string, Promise<ArrayBuffer>>; downloads: Set<AbortController>;
  searchSequence: number; searchWork: Promise<unknown>; pendingVectorKeys: Set<string>;
  status: EmbeddingStatus; startTimer?: ReturnType<typeof setTimeout> | null;
  starting?: boolean; ready?: boolean; indexing?: boolean; reindex?: boolean;
  enabled(): boolean; key(con: Con): string; update(changes: Partial<EmbeddingStatus>): void;
  files(): FileSystem; directory(): string; vectorDirectory(): string; vectorFile(key: string): string;
  download(url: string, generation: number): Promise<import('../platform/types.ts').DownloadResponse>;
  asset(url: string, generation: number, expectedHash?: string): Promise<ArrayBuffer>;
  readAsset(url: string, generation: number, expectedHash?: string): Promise<ArrayBuffer>;
  call(action: string, args?: EmbeddingArguments): Promise<EmbeddingResult>;
  stop(): void; toggle(enabled: boolean): void; start(): void; runStart(): Promise<void>; index(): Promise<void>;
  cancelSearch(): void; search(text: string): Promise<SearchResult[]>;
}
export interface AnimationTiming {count: number; duration: number; loops: number}
