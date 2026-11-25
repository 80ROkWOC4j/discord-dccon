import type {Platform} from '../platform/types.ts';
import type {CloudflareCredentials} from './types.ts';

export const CLOUDFLARE_EMBEDDING_SPEC = 'cf-embeddinggemma-2-v1';
export const CLOUDFLARE_KEYS_NEEDED = 'API 키 설정 필요';
export const CLOUDFLARE_SETUP_HINT = CLOUDFLARE_KEYS_NEEDED + ' · 설정에서 Cloudflare API 키를 입력해 주세요.';
export const CLOUDFLARE_BATCH_ITEMS = 4;
export const CLOUDFLARE_BODY_LIMIT = 2_000_000;
const MODEL = '@cf/google/embeddinggemma-2';
const REQUEST_TIMEOUT = 45_000;
const QUERY_CACHE_SIZE = 50;
const FRAME_LIMIT = 6;

interface ImageBlock {type: 'image_url'; image_url: {url: string}}
export type CloudflareImage = [{role: 'user'; content: ImageBlock[]}];

export class CloudflareEmbeddingError extends Error {
  readonly fatal: boolean;
  readonly splittable: boolean;
  constructor(message: string, fatal = false, splittable = false) {
    super(message); this.fatal = fatal; this.splittable = splittable;
  }
}

export function normalizeCloudflareCredentials(credentials?: CloudflareCredentials): CloudflareCredentials {
  const accountId = typeof credentials?.accountId === 'string' ? credentials.accountId.trim() : '';
  const apiToken = typeof credentials?.apiToken === 'string' ? credentials.apiToken.trim() : '';
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new CloudflareEmbeddingError('Account ID는 32자리 16진수여야 합니다.');
  if (!apiToken || /[^\x21-\x7e]/.test(apiToken)) throw new CloudflareEmbeddingError('유효한 Cloudflare API Token을 입력해 주세요.');
  return {accountId, apiToken};
}

function invalidResponse() {return new CloudflareEmbeddingError('Cloudflare에서 유효하지 않은 임베딩 결과를 받았습니다.');}
function readVectors(body: unknown, count: number): number[][] {
  const result = body as {success?: boolean; result?: {data?: {index?: number; embedding?: unknown}[]}} | null;
  const rows = result?.result?.data;
  if (result?.success !== true || !Array.isArray(rows) || rows.length !== count) throw invalidResponse();
  const vectors: number[][] = [];
  for (const row of rows) {
    const index = row?.index, vector = row?.embedding;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count || vectors[index] ||
        !Array.isArray(vector) || vector.length !== 768 || !vector.every(Number.isFinite)) throw invalidResponse();
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || !norm) throw invalidResponse();
    vectors[index] = vector.map(value => value / norm);
  }
  return vectors;
}

function responseError(status: number, body: unknown) {
  if (status === 400) {
    const errors = (body as {errors?: {code?: number}[]} | null)?.errors;
    if (Array.isArray(errors) && errors.some(error => error?.code === 8006))
      return new CloudflareEmbeddingError('Cloudflare가 이미지 형식을 읽지 못했습니다 (400).', false, true);
    if (Array.isArray(errors) && errors.some(error => error?.code === 5006))
      return new CloudflareEmbeddingError('Cloudflare가 임베딩 요청 형식을 거부했습니다 (400).', false, true);
  }
  return new CloudflareEmbeddingError(Number.isInteger(status) && status >= 400 && status <= 599
    ? `Cloudflare 임베딩 요청에 실패했습니다 (${status}).` : 'Cloudflare 임베딩 요청에 실패했습니다.');
}

export function createCloudflareEmbedding(net: Platform['net'], verifyConfiguration?: (signal?: AbortSignal) => Promise<void>) {
  const requests = new Set<AbortController>(), queryCache = new Map<string, number[]>();
  let epoch = 0;
  async function request(credentials: CloudflareCredentials, payload: {input: string[]} | {messages: CloudflareImage[]},
    count: number, signal?: AbortSignal) {
    const {accountId, apiToken} = normalizeCloudflareCredentials(credentials);
    const body = JSON.stringify(payload);
    if (body.length > CLOUDFLARE_BODY_LIMIT) throw new CloudflareEmbeddingError('Cloudflare 임베딩 요청 크기 제한을 초과했습니다.');
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.throwIfAborted();
    signal?.addEventListener('abort', abort, {once: true});
    requests.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => {timedOut = true; abort();}, REQUEST_TIMEOUT);
    try {
      if (verifyConfiguration) await verifyConfiguration(controller.signal);
      controller.signal.throwIfAborted();
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`;
      const response = await net.fetch(url, {method: 'POST', headers: {Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json'}, body, redirect: 'manual', signal: controller.signal});
      controller.signal.throwIfAborted();
      const {status} = response;
      if (status === 401 || status === 403) throw new CloudflareEmbeddingError(`Cloudflare 인증에 실패했습니다 (${status}). API 키와 Workers AI 권한을 확인해 주세요.`, true);
      if (status === 429) throw new CloudflareEmbeddingError('Cloudflare 사용량 또는 요청 한도에 도달했습니다 (429). 잠시 후 다시 시도해 주세요.', true);
      if (status === 0 || (status >= 300 && status < 400)) throw new CloudflareEmbeddingError('Cloudflare 리다이렉트가 차단되었습니다.', true);
      const raw = await response.text();
      controller.signal.throwIfAborted();
      let json: unknown;
      try {json = JSON.parse(raw);} catch { /* Never expose arbitrary response bodies. */ }
      if (!response.ok || status < 200 || status >= 300) throw responseError(status, json);
      return readVectors(json, count);
    } catch (error) {
      if (timedOut) throw new CloudflareEmbeddingError('Cloudflare 연결 시간이 초과되었습니다.');
      controller.signal.throwIfAborted();
      if (error instanceof CloudflareEmbeddingError) throw error;
      // Native fetch errors can include the URL (and therefore the account ID).
      throw new CloudflareEmbeddingError('Cloudflare에 연결하지 못했습니다. 네트워크 연결을 확인해 주세요.');
    } finally {
      clearTimeout(timeout); requests.delete(controller); signal?.removeEventListener('abort', abort);
    }
  }

  const queryVector = async (credentials: CloudflareCredentials, text: string, signal?: AbortSignal) =>
    (await request(credentials, {input: ['task: search result | query: ' + text]}, 1, signal))[0];

  return {
    async query(credentials: CloudflareCredentials, text: string, signal: AbortSignal) {
      // The embedding service resets this cache on credential/provider changes.
      signal.throwIfAborted();
      const activeEpoch = epoch;
      let vector = queryCache.get(text);
      if (vector) {
        if (verifyConfiguration) await verifyConfiguration(signal);
      } else vector = await queryVector(credentials, text, signal);
      signal.throwIfAborted();
      if (activeEpoch !== epoch) throw Error('검색이 취소되었습니다.');
      queryCache.delete(text);
      queryCache.set(text, vector);
      if (queryCache.size > QUERY_CACHE_SIZE) queryCache.delete(queryCache.keys().next().value!);
      return vector;
    },
    imageBatch: (credentials: CloudflareCredentials, messages: CloudflareImage[]) => request(credentials, {messages}, messages.length),
    async test(credentials: CloudflareCredentials, signal?: AbortSignal) {await queryVector(credentials, '연결 테스트', signal);},
    stop() {
      epoch++; queryCache.clear();
      for (const controller of requests) controller.abort();
      requests.clear();
    },
  };
}

export function sampleCloudflareFrames(durations: number[]) {
  if (durations.length <= FRAME_LIMIT) return durations.map((_, i) => i);
  const total = durations.reduce((a, b) => a + b, 0), selected = new Set<number>();
  let index = 0, end = durations[0];
  for (let i = 0; i < FRAME_LIMIT; i++) {
    const target = total * (i + 0.5) / FRAME_LIMIT;
    while (index < durations.length - 1 && end <= target) end += durations[++index];
    selected.add(index);
  }
  return [...selected];
}

function encodeFrame(source: VideoFrame | ImageBitmap, edge: number): ImageBlock {
  const width = 'displayWidth' in source ? source.displayWidth : source.width;
  const height = 'displayHeight' in source ? source.displayHeight : source.height;
  const scale = Math.min(1, edge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d', {alpha: false})!;
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return {type: 'image_url', image_url: {url: canvas.toDataURL('image/jpeg', 0.86)}};
}

export async function prepareCloudflareImage(file: File, checkActive: () => void): Promise<CloudflareImage> {
  const conversation = (content: ImageBlock[]): CloudflareImage => [{role: 'user', content}];
  checkActive();
  if ((file.type === 'image/gif' || file.type === 'image/webp') && typeof ImageDecoder !== 'undefined') {
    try {
      const data = await file.arrayBuffer();
      checkActive();
      const decoder = new ImageDecoder({data, type: file.type});
      try {
        await decoder.tracks.ready;
        checkActive();
        const count = decoder.tracks.selectedTrack?.frameCount || 0, durations: number[] = [];
        const decode = async <T>(frameIndex: number, read: (image: VideoFrame) => T) => {
          checkActive();
          const {image} = await decoder.decode({frameIndex});
          try {checkActive(); return read(image);} finally {image.close();}
        };
        if (count > FRAME_LIMIT) {
          for (let i = 0; i < count; i++) durations.push(await decode(i, image => Math.max(1, image.duration || 100_000)));
        }
        const content: ImageBlock[] = [];
        for (const index of count > FRAME_LIMIT ? sampleCloudflareFrames(durations) : Array.from({length: count}, (_, i) => i)) {
          content.push(await decode(index, image => encodeFrame(image, count === 1 ? 384 : 256)));
        }
        if (content.length) return conversation(content);
      } finally {decoder.close();}
    } catch {checkActive(); /* Unsupported decoder/format: fall back to the first frame. */}
  }
  const bitmap = await createImageBitmap(file);
  try {checkActive(); return conversation([encodeFrame(bitmap, 384)]);} finally {bitmap.close();}
}
