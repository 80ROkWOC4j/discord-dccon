import type {Failure} from './types.ts';
import type {Binary} from './services.ts';
import type {WorkerScope, CodecRequest, CodecLibrary, CodecModule, EmbeddingRequest, TransformerLibrary, Processor, Model, TensorMap, RawImageData, RawFrame, RawVideoData} from './worker-types.ts';
export function webpWorker() {
    const self = globalThis as unknown as WorkerScope<CodecRequest>;
    const tools = new Map<string, {lib: CodecLibrary; wasm: Binary}>();
    self.onmessage = async ({data: {bytes, kind, runtime, frames, loopCount = 0, compositeGif = false}}) => {
      try {
        if (!tools.has(kind)) {
          const url = URL.createObjectURL(new Blob([runtime.source], {type: "text/javascript"}));
          try {tools.set(kind, {lib: await import(url) as CodecLibrary, wasm: runtime.wasm});}
          finally {URL.revokeObjectURL(url);}
        }
        const {lib, wasm} = tools.get(kind)!;
        // Fresh instances reclaim CLI argv allocations and GIF decoder state between images.
        const wasmURL = URL.createObjectURL(new Blob([wasm], {type: "application/wasm"}));
        // This codec build has no wasmBinary hook. Serve its WASM fetch from
        // memory inside this dedicated worker; Discord CSP can block blob fetches.
        const fetch = self.fetch;
        self.fetch = (input, options) => input === wasmURL
          ? Promise.resolve(new Response(wasm, {headers: {"Content-Type": "application/wasm"}}))
          : fetch(input, options);
        let module: CodecModule;
        try {module = await (kind === "gif" ? lib.Gif2Webp : lib.Img2Webp)({locateFile: () => wasmURL});}
        finally {self.fetch = fetch; URL.revokeObjectURL(wasmURL);}
        if (compositeGif) {
          // Chromium accepts out-of-bounds GIF rectangles and composites them on the logical screen.
          const decoder = new ImageDecoder({data: bytes, type: "image/gif"});
          try {
            await decoder.tracks.ready;
            const track = decoder.tracks.selectedTrack!;
            loopCount = Number.isFinite(track.repetitionCount) ? track.repetitionCount + 1 : 0;
            frames = [];
            for (let frameIndex = 0; frameIndex < track.frameCount; frameIndex++) {
              const {image} = await decoder.decode({frameIndex});
              try {
                const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
                canvas.getContext("2d")!.drawImage(image, 0, 0);
                const png = await canvas.convertToBlob({type: "image/png"});
                frames.push({bytes: new Uint8Array(await png.arrayBuffer()),
                  duration: Math.max(1, Math.round((image.duration ?? 100000) / 1000))});
              } finally {image.close();}
            }
          } finally {decoder.close();}
        }
        module.FS.writeFile("/input", new Uint8Array(bytes));
        const args = frames ? ["-loop", String(loopCount), "-lossless", "-m", "4", ...frames.flatMap((frame, index) => {
          const name = `/frame${index}.png`; module.FS.writeFile(name, frame.bytes);
          return ["-d", String(frame.duration), name];
        }), "-o", "/output.webp"] : kind === "gif" ? ["-quiet", "-m", "4", "/input", "-o", "/output.webp"]
          : ["-lossless", "-m", "4", "/input", "-o", "/output.webp"];
        const parsed = (kind === "gif" ? lib.parseGif2WebpArgs : lib.parseImg2WebpArgs)(module, args);
        if (module._main(...parsed) !== 0) throw Object.assign(Error("이미지를 WebP로 변환하지 못했습니다."),
          {gifFrameError: kind === "gif"});
        const output = module.FS.readFile("/output.webp");
        self.postMessage({bytes: output.buffer}, [output.buffer]);
      } catch (_error) { const error = _error as Failure;self.postMessage({error: error.message || String(error), gifFrameError: error.gifFrameError === true});}
    };
  }

export async function embeddingWorker() {
  const self = globalThis as unknown as WorkerScope<EmbeddingRequest>;
  let model: Model, processor: Processor, RawImage: TransformerLibrary['RawImage'], RawVideo: TransformerLibrary['RawVideo'], RawVideoFrame: TransformerLibrary['RawVideoFrame'];
  let requestId = 0, work = Promise.resolve();
  const downloads = new Map<number, {resolve(response: Response): void; reject(error: Error): void}>();
  const nativeFetch = self.fetch.bind(self);
  self.fetch = (url, options) => String(url).startsWith("blob:") ? nativeFetch(url, options) : new Promise((resolve, reject) => {
    const id = ++requestId;
    downloads.set(id, {resolve, reject});
    self.postMessage({download: id, url: String(url).replace("/resolve/main/", "/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/")});
  });
  const normalize = (vector: ArrayLike<number>) => {
    const norm = Math.hypot(...Array.from(vector));
    if (vector.length !== 768 || !Number.isFinite(norm) || !norm) throw Error("유효하지 않은 임베딩 결과");
    return Array.from(vector, value => value / norm);
  };
  const embed = async (text: string | null, images?: RawImageData[] | null, video: RawVideoData | null = null) => {
    const inputs = await processor(text, images, null, video);
    let output: TensorMap | undefined;
    try { output = await model(inputs); return normalize(output.sentence_embedding.data); }
    finally {
      for (const tensor of Object.values(inputs)) tensor?.dispose?.();
      for (const tensor of Object.values(output || {})) tensor?.dispose?.();
    }
  };
  const decode = async (bytes: ArrayBuffer, type: string) => {
    const images: RawImageData[] = [], frames: RawFrame[] = [];
    let video: RawVideoData | null = null;
    const add = async (source: VideoFrame | ImageBitmap) => {
      const dimensions = source as VideoFrame & ImageBitmap;
      const canvas = new OffscreenCanvas(dimensions.displayWidth || dimensions.width, dimensions.displayHeight || dimensions.height);
      const ctx = canvas.getContext("2d", {willReadFrequently: true})!;
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(source, 0, 0);
      const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const rgb = new Uint8ClampedArray(canvas.width * canvas.height * 3);
      for (let i = 0, j = 0; i < rgba.length; i += 4) {rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2];}
      images.push(new RawImage(rgb, canvas.width, canvas.height, 3));
    };
    if (type === "image/gif" || type === "image/webp") {
      if (typeof ImageDecoder === "undefined") throw Error("이 환경은 GIF 프레임 디코딩을 지원하지 않습니다.");
      const decoder = new ImageDecoder({data: bytes, type});
      try {
        await decoder.tracks.ready;
        const count = decoder.tracks.selectedTrack!.frameCount, durations = [];
        for (let i = 0; i < count; i++) {
          const {image} = await decoder.decode({frameIndex: i});
          durations.push(Math.max(1, image.duration || 100000)); image.close();
        }
        const total = durations.reduce((a, b) => a + b, 0), selected = new Set<number>();
        for (let i = 0; i < Math.min(6, count); i++) {
          if (count <= 6) {selected.add(i); continue;}
          const target = total * (i + 0.5) / 6;
          let elapsed = 0;
          selected.add(durations.findIndex(duration => (elapsed += duration) > target));
        }
        for (const frameIndex of selected) {
          const {image} = await decoder.decode({frameIndex});
          try {
            await add(image);
            frames.push(new RawVideoFrame(images.at(-1)!, durations.slice(0, frameIndex).reduce((a, b) => a + b, 0) / 1000000));
          } finally {image.close();}
        }
        if (count > 1) video = new RawVideo(frames, total / 1000000);
      } finally {decoder.close();}
    } else {
      const bitmap = await createImageBitmap(new Blob([bytes], {type}));
      try {await add(bitmap);} finally {bitmap.close();}
    }
    return {images: video ? null : images, video};
  };
  self.onmessage = ({data}) => {
    if (data.download !== undefined) {
      const task = downloads.get(data.download)!; downloads.delete(data.download);
      if (data.error) task.reject(Error(data.error));
      else task.resolve(new Response(data.bytes, {status: 200, headers: {"Content-Length": String(data.bytes.byteLength)}}));
      return;
    }
    work = work.then(async () => {
      try {
        let result;
        if (data.action === "init") {
          const lib = await import(data.library) as TransformerLibrary;
          RawImage = lib.RawImage; RawVideo = lib.RawVideo; RawVideoFrame = lib.RawVideoFrame;
          lib.env.allowLocalModels = false; lib.env.useBrowserCache = false; lib.env.useWasmCache = false;
          lib.env.backends.onnx.wasm.numThreads = 1;
          lib.env.backends.onnx.wasm.wasmBinary = data.wasm;
          lib.env.backends.onnx.wasm.wasmPaths = {mjs: data.factory};
          const options = {revision: "daa72c51243991dfcaf9f9137d2c573d8f7790c0"};
          const name = "onnx-community/embeddinggemma-2-ONNX";
          processor = await lib.AutoProcessor.from_pretrained(name, options);
          processor.image_processor.max_soft_tokens = 280;
          processor.video_processor.frame_processor.max_soft_tokens = 140;
          processor.video_processor.max_frames = 6;
          const config = await lib.AutoConfig.from_pretrained(name, options); config.audio_config = null;
          model = await lib.AutoModel.from_pretrained(name, {...options, config, device: "webgpu", dtype: "q4"});
          result = {device: "webgpu"};
        } else if (data.action === "image") {
          const decoded = await decode(data.bytes, data.type);
          result = await embed(null, decoded.images, decoded.video);
        }
        else if (data.action === "query") result = await embed("task: search result | query: " + data.text);
        self.postMessage({id: data.id, result});
      } catch (_error) { const error = _error as Failure;self.postMessage({id: data.id, error: String(error.message || error)});}
    });
  };
}
