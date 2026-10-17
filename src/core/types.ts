export type PackId = string | number;
export interface Con {idx: PackId; title: string; ext: string; path: string; packageIdx?: PackId}
export interface Pack {info: {package_idx: PackId; title: string; main_img_path?: string; list_img_path?: string}; detail: Con[]}
export interface PackSearchResult {idx: string; thumbId: string; name: string; seller: string}
export interface Settings {
  dccons: Pack[]; dcconsBeforeDedup: Pack[]; favorites: Con[]; recent: Con[];
  personalCons: Con[]; collapsedPacks: Record<string, boolean>; embeddingEnabled: boolean;
}
export interface QueueEntry {con: Con; file: File}
export interface PreparedCon {con: Con; file: File}
export interface SearchResult {con: Con; score: number}
export interface PluginMeta {name: string; version?: string}
export interface Failure extends Error {code?: string | number; status?: number; statusCode?: number; gifFrameError?: boolean; body?: {code?: string | number}}
export interface SendAttempt {
  phase?: string; updatedAt?: string; startedAt?: string; outcome?: string; mode?: string; keepOpen?: boolean;
  hasChannel?: boolean; attachmentIndex?: number; attachmentCount?: number; imageBytes?: number;
  listenerCleanup?: string; hasUploadedFilename?: boolean; queuedCount?: number; sentCount?: number;
  restModule?: {keys: string[]; postParameterCount: number; postImplementation: string};
  cleanupError?: DiagnosticError; uploadError?: DiagnosticError; error?: DiagnosticError;
  responseShape?: ResponseShape; httpStatus?: number | null; apiCode?: number | null; hasMessageId?: boolean;
}
export interface PluginEvent {type: string; channelId?: string}
export type EventListener = (event: PluginEvent) => void;
export interface FileSystem {
  readFile(file: string, encoding: null): Promise<Uint8Array<ArrayBuffer> | string>;
  readFile(file: string, encoding: 'utf8'): Promise<string>;
  mkdir(file: string, options: {recursive: boolean}): Promise<unknown>;
  writeFile(file: string, bytes: Uint8Array | string): Promise<unknown>;
  rename(source: string, destination: string): Promise<unknown>;
  unlink(file: string): Promise<unknown>;
}
export interface DiscordResponse {
  status?: number; ok?: boolean; id?: string; text?: string; data?: {id?: string};
  body?: {id?: string; code?: number} | string | null;
  headers?: {get?(name: string): string | null; 'content-type'?: string};
}
export interface Attachment {id: string; filename: string; uploaded_filename: string}
export interface DiscordRest {post(request: {url: string; body: {content: string; nonce: string; enforce_nonce: boolean; type: number; sticker_ids: string[]; allowed_mentions: {parse: string[]}; attachments: Attachment[]}}): Promise<DiscordResponse>}

export interface DiagnosticError {name: string; message: string; status: number | null; code: string | number | null}
export interface ResponseShape {
  responseType: string; responseKeys: string[]; bodyType: string; bodyKeys: string[];
  contentType: string | null; looksLikeHtml: boolean; bodyStringLength: number | null; hasTopLevelId: boolean; hasDataId: boolean;
}
