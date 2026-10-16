import type {Binary, CodecRuntime, Frame} from './services.ts';
export interface WorkerScope<T> {
  fetch: typeof fetch;
  onmessage: ((event: MessageEvent<T>) => unknown) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
export interface CodecRequest {bytes: Binary; kind: 'gif' | 'img'; runtime: CodecRuntime; frames?: Frame[]; loopCount?: number; compositeGif?: boolean}
export interface CodecModule {FS: {writeFile(path: string, bytes: Binary): void; readFile(path: string): Binary}; _main(...args: number[]): number}
export interface CodecLibrary {
  Gif2Webp(options: {locateFile(): string}): Promise<CodecModule>;
  Img2Webp(options: {locateFile(): string}): Promise<CodecModule>;
  parseGif2WebpArgs(module: CodecModule, args: (string | number)[]): number[];
  parseImg2WebpArgs(module: CodecModule, args: (string | number)[]): number[];
}
export interface RawImageData {data: Uint8ClampedArray; width: number; height: number}
export interface RawFrame {image: RawImageData; timestamp: number}
export interface RawVideoData {frames: RawFrame[]; duration: number}
export interface Tensor {data: ArrayLike<number>; dispose?(): void}
export type TensorMap = Record<string, Tensor>;
export interface Processor {
  (text: string | null, images?: RawImageData[] | null, audio?: null, video?: RawVideoData | null): Promise<TensorMap>;
  image_processor: {max_soft_tokens: number};
  video_processor: {frame_processor: {max_soft_tokens: number}; max_frames: number};
}
export type Model = (inputs: TensorMap) => Promise<TensorMap>;
export interface TransformerLibrary {
  RawImage: new (data: Uint8ClampedArray, width: number, height: number, channels: number) => RawImageData;
  RawVideoFrame: new (image: RawImageData, time: number) => RawFrame;
  RawVideo: new (frames: RawFrame[], duration: number) => RawVideoData;
  AutoProcessor: {from_pretrained(name: string, options: Record<string, unknown>): Promise<Processor>};
  AutoConfig: {from_pretrained(name: string, options: Record<string, unknown>): Promise<Record<string, unknown>>};
  AutoModel: {from_pretrained(name: string, options: Record<string, unknown>): Promise<Model>};
  env: {allowLocalModels: boolean; useBrowserCache: boolean; useWasmCache: boolean;
    backends: {onnx: {wasm: {numThreads: number; wasmBinary: ArrayBuffer; wasmPaths: {mjs: string}}}}};
}
export type EmbeddingRequest = {download: number; bytes: ArrayBuffer; error?: string}
  | {download?: never; id: number; action: 'init'; library: string; wasm: ArrayBuffer; factory: string}
  | {download?: never; id: number; action: 'image'; bytes: ArrayBuffer; type: string}
  | {download?: never; id: number; action: 'query'; text: string};
