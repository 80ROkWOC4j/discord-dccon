/// <reference types="@jsquash/webp/emscripten-types" />
import type {WebPModule} from '@jsquash/webp/codec/enc/webp_enc.js';
import type {Binary} from './services.ts';
import type {WorkerScope} from './worker-types.ts';
import type {Failure} from './types.ts';
interface AnimationSource {decoder: ImageDecoder; ends: number[]; duration: number; index: number; image: VideoFrame | null; loops?: number; width?: number; height?: number}
interface MuxFrame {buffer: Buffer; delay: number; blend: boolean; dispose: boolean}
const self = globalThis as unknown as WorkerScope<{bytes: Binary; wasm: Binary; images?: Binary[]}>;
import createEncoder from "@jsquash/webp/codec/enc/webp_enc.js";
import {defaultOptions} from "@jsquash/webp/meta.js";
import {Image} from "node-webpmux";
import {Buffer} from "buffer";

let initialized: Promise<WebPModule> | undefined;
async function mergeAnimations(inputs: Binary[], encoder: WebPModule) {
  const sources: AnimationSource[] = [], frames: MuxFrame[] = [];
  try {
    if (inputs.length < 2 || inputs.length > 3) throw Error("애니메이션 2~3개만 합칠 수 있습니다.");
    for (const bytes of inputs) {
      const decoder = new ImageDecoder({data: bytes, type: "image/webp"});
      const source: AnimationSource = {decoder, ends: [], duration: 0, index: -1, image: null};
      sources.push(source);
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack!;
      if (track.frameCount < 2) throw Error("애니메이션 이미지끼리만 합칠 수 있습니다.");
      source.loops = Number.isFinite(track.repetitionCount) ? track.repetitionCount + 1 : 0;
      for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
        const {image} = await decoder.decode({frameIndex});
        try {
          source.width = image.displayWidth; source.height = image.displayHeight;
          source.duration += Math.max(1, Math.round((image.duration ?? 100000) / 1000));
          source.ends.push(source.duration);
        } finally {image.close();}
      }
    }
    if (sources.some(source => source.duration !== sources[0].duration)) throw Error("애니메이션 재생 길이가 같아야 합니다.");
    if (sources.some(source => source.loops !== sources[0].loops)) throw Error("애니메이션 반복 횟수가 같아야 합니다.");
    const width = sources.reduce((sum, source) => sum + source.width!, 0), height = Math.max(...sources.map(source => source.height!));
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext("2d", {willReadFrequently: true})!;
    const times = [...new Set([0, ...sources.flatMap(source => source.ends)])].sort((a, b) => a - b);
    for (let step = 0; step < times.length - 1; step++) {
      context.clearRect(0, 0, width, height);
      let x = 0;
      for (const source of sources) {
        let index = Math.max(0, source.index);
        while (source.ends[index] <= times[step]) index++;
        if (index !== source.index) {
          source.image?.close(); source.image = null;
          source.image = (await source.decoder.decode({frameIndex: index})).image; source.index = index;
        }
        context.drawImage(source.image!, x, Math.floor((height - source.height!) / 2));
        x += source.width!;
      }
      const output = encoder.encode(context.getImageData(0, 0, width, height).data, width, height, {
        ...defaultOptions, lossless: 1, quality: 75, method: 0, exact: 1,
      });
      if (!output) throw Error("합친 이미지 인코딩에 실패했습니다.");
      frames.push({buffer: Buffer.from(output), delay: times[step + 1] - times[step], blend: false, dispose: false});
    }
    return new Uint8Array(await Image.save(null, {width, height, loops: sources[0].loops,
      frames: await Promise.all(frames.map(frame => Image.generateFrame(frame)))}));
  } finally {
    for (const source of sources) {source.image?.close(); source.decoder.close();}
  }
}
self.onmessage = async ({data: {bytes, wasm, images}}) => {
  let decoder;
  try {
    // Use the non-SIMD encoder explicitly so one pinned binary works on all hosts.
    if (!initialized) initialized = createEncoder({
      wasmBinary: wasm,
      locateFile: () => "https://local.invalid/split-encoder.wasm",
    });
    const encoder = await initialized;
    if (images) {
      const output = await mergeAnimations(images, encoder);
      self.postMessage({bytes: output.buffer}, [output.buffer]);
      return;
    }
    const type = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" ? "image/webp"
      : bytes[0] === 71 ? "image/gif" : bytes[0] === 137 ? "image/png" : "image/jpeg";
    decoder = new ImageDecoder({data: bytes, type});
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack!;
    const tiles = Array.from({length: 9}, (): MuxFrame[] => []);
    let canvas: OffscreenCanvas | undefined, context!: OffscreenCanvasRenderingContext2D, tileSize!: number;
    for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
      const {image} = await decoder.decode({frameIndex});
      try {
        if (!canvas) {
          tileSize = Math.ceil(Math.max(image.displayWidth, image.displayHeight) / 3);
          canvas = new OffscreenCanvas(tileSize, tileSize);
          context = canvas.getContext("2d", {willReadFrequently: true})!;
        }
        const side = tileSize * 3, scale = side / Math.max(image.displayWidth, image.displayHeight);
        const width = image.displayWidth * scale, height = image.displayHeight * scale;
        for (let index = 0; index < 9; index++) {
          context.clearRect(0, 0, tileSize, tileSize);
          context.drawImage(image, (side - width) / 2 - (index % 3) * tileSize,
            (side - height) / 2 - Math.floor(index / 3) * tileSize, width, height);
          const output = encoder.encode(context.getImageData(0, 0, tileSize, tileSize).data, tileSize, tileSize, {
            ...defaultOptions, lossless: 1, quality: 75, method: 0, exact: 1,
          });
          if (!output) throw Error("분할 이미지 인코딩에 실패했습니다.");
          tiles[index].push({buffer: Buffer.from(output),
            delay: Math.max(1, Math.round((image.duration ?? 100000) / 1000)), blend: false, dispose: false});
        }
      } finally {image.close();}
    }
    const loops = Number.isFinite(track.repetitionCount) ? track.repetitionCount + 1 : 0;
    const results = [];
    for (const tile of tiles) {
      const bytes = tile.length === 1 ? tile[0].buffer : await Image.save(null, {
        width: tileSize, height: tileSize, loops,
        frames: await Promise.all(tile.map(frame => Image.generateFrame(frame))),
      });
      results.push(new Uint8Array(bytes).buffer);
    }
    self.postMessage({tiles: results}, results);
  } catch (caught) {const error = caught as Failure;self.postMessage({error: error.message || String(error)});}
  finally {decoder?.close();}
};
