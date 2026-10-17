// Only the external codec surface used by the worker is described here.
declare namespace EmscriptenWasm {
  interface ModuleOpts {wasmBinary?: Uint8Array<ArrayBuffer>}
}
declare module 'node-webpmux' {
  export const Image: {
    generateFrame(options: {buffer: Uint8Array; delay: number; blend: boolean; dispose: boolean}): Promise<unknown>;
    save(path: null, options: {width: number; height: number; loops?: number; frames: unknown[]}): Promise<Uint8Array<ArrayBuffer>>;
  };
}
