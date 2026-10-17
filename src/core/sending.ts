import type {Platform} from '../platform/types.ts';
import type {Con, QueueEntry, SendAttempt, Failure, DiscordResponse, DiscordRest, Attachment} from './types.ts';
import type {SettingsService} from './settings.ts';
import type {Images} from './images.ts';
import type {Events} from './events.ts';
export function createSending(platform: Platform, settings: SettingsService, images: Images, PluginEvents: Events) {
  const {loadData, saveData} = settings;
  let lastMessageNonce = 0n;
  let lastSendAttempt: SendAttempt | null = null;
  const queuedCons = new Map<string, QueueEntry[]>();
  const channelTasks = new Map<string, Promise<boolean>>();
  const sendingChannels = new Set<string>();
  function activeQueue(channelId: string) { return queuedCons.get(channelId) ?? []; }
  function updateQueue(channelId: string, entries: QueueEntry[]) {
    queuedCons.set(channelId, entries);
    PluginEvents.dispatch({ type: "DCCON_BUFFER_UPDATE", channelId });
  }
  function removeBuffered(channelId: string, entry?: QueueEntry) {
    if (sendingChannels.has(channelId)) return;
    updateQueue(channelId, entry ? activeQueue(channelId).filter(item => item !== entry) : []);
  }

  function markSend(attempt: SendAttempt, phase: string, details: Partial<SendAttempt> = {}) {
    Object.assign(attempt, details, { phase, updatedAt: new Date().toISOString() });
  }

  function sendErrorDetails(error: Failure | undefined) {
    return {
      name: error?.name || "Error",
      message: String(error?.message || "오류 설명 없음").replace(/https?:\/\/\S+/g, "[URL]").slice(0, 400),
      status: error?.status ?? error?.statusCode ?? null,
      code: error?.body?.code ?? error?.code ?? null,
    };
  }

  function responseShape(response: DiscordResponse | undefined) {
    const body = response?.body;
    const header = response?.headers?.get?.("content-type") ?? response?.headers?.["content-type"];
    const keys = (value: unknown) => value && typeof value === "object" ? Object.keys(value).slice(0, 30) : [];
    return {
      responseType: typeof response,
      responseKeys: keys(response),
      bodyType: body === null ? "null" : Array.isArray(body) ? "array" : typeof body,
      bodyKeys: keys(body),
      contentType: typeof header === "string" ? header.slice(0, 100) : null,
      looksLikeHtml: [body, response?.text].some(value => typeof value === "string" && /^\s*(?:<!doctype\s+html|<html)/i.test(value)),
      bodyStringLength: typeof body === "string" ? body.length : null,
      hasTopLevelId: Boolean(response?.id),
      hasDataId: Boolean(response?.data?.id),
    };
  }

  async function sendImagesDirectly(files: File[], channelId: string, attempt: SendAttempt) {
    markSend(attempt, "모듈 조회");
    const CloudUpload = platform.discord.uploadModule();
    const rest = platform.discord.restModule();
    if (!CloudUpload || !rest) throw new Error("즉시 전송 모듈을 찾지 못했습니다. 진단 탭을 확인해 주세요.");
    attempt.restModule = {
      keys: Object.keys(rest).slice(0, 40),
      postParameterCount: rest.post.length,
      // Function source contains code only, not request arguments or closure values.
      postImplementation: Function.prototype.toString.call(rest.post).slice(0, 600),
    };
    const attachments = [];
    for (const [index, file] of files.entries()) {
      markSend(attempt, "업로드 객체 생성", { attachmentIndex: index + 1, attachmentCount: files.length, imageBytes: files.reduce((sum, image) => sum + image.size, 0) });
      const upload = new CloudUpload({ file, isThumbnail: false, platform: 1 }, channelId);
      markSend(attempt, "Discord 파일 업로드", {
        listenerCleanup: typeof upload.off === "function" ? "off" : typeof upload.removeListener === "function" ? "removeListener" : "none",
      });
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          // Listener cleanup must not prevent a completed upload from settling.
          try {
            const remove = upload.off ?? upload.removeListener;
            remove?.call(upload, "complete", complete);
            remove?.call(upload, "error", fail);
          } catch (_error) { const error = _error as Failure; attempt.cleanupError = sendErrorDetails(error); }
        };
        const complete = () => { cleanup(); markSend(attempt, "Discord 업로드 완료", { hasUploadedFilename: Boolean(upload.uploadedFilename) }); resolve(); };
        const fail = (error?: Failure) => {
          cleanup();
          attempt.uploadError = sendErrorDetails(error || upload.error);
          reject(new Error("이미지 업로드에 실패했습니다. 진단 탭의 마지막 전송 결과를 확인해 주세요."));
        };
        const timer = setTimeout(() => {
          cleanup();
          try { upload.cancel(); } catch { /* Preserve the timeout error if cancellation also fails. */ }
          reject(new Error("이미지 업로드 시간이 초과되었습니다."));
        }, 120000);
        upload.on("complete", complete);
        upload.on("error", fail);
        try { Promise.resolve(upload.upload()).catch(fail); } catch (_error) { const error = _error as Failure; fail(error); }
      });
      if (!upload.uploadedFilename) throw new Error("업로드 결과에 파일 경로가 없습니다.");
      attachments.push({ id: String(index), filename: upload.filename || file.name, uploaded_filename: upload.uploadedFilename });
    }
    await postDCCon(rest, channelId, attempt, attachments);
  }

  async function postDCCon(rest: DiscordRest, channelId: string, attempt: SendAttempt, attachments: Attachment[]) {
    const timestampNonce = (BigInt(Date.now()) - 1420070400000n) << 22n;
    lastMessageNonce = timestampNonce > lastMessageNonce ? timestampNonce : lastMessageNonce + 1n;
    // Send only plugin-owned files; leave composer text and reply untouched.
    markSend(attempt, "메시지 생성 요청");
    const response = await rest.post({
      url: `/channels/${channelId}/messages`,
      body: {
        content: "", nonce: String(lastMessageNonce), enforce_nonce: true,
        type: 0, sticker_ids: [], allowed_mentions: { parse: [] },
        attachments,
      },
    });
    const body = response?.body as {id?: string; code?: number} | undefined;
    markSend(attempt, "메시지 생성 응답", {
      responseShape: responseShape(response),
      httpStatus: response?.status ?? null,
      apiCode: body?.code ?? null,
      hasMessageId: Boolean(body?.id),
    });
    if (response?.ok === false || response?.status! >= 400) {
      throw new Error(`메시지 전송 실패 (HTTP ${response.status ?? "오류"}).`);
    }
    if (!body?.id) throw new Error("전송 성공을 확인할 수 없습니다. 채널과 진단 결과를 확인해 주세요. 자동 재전송하지 않습니다.");
  }
  let bufferGeneration = 0;
  let currentChannelId = "";
  const sendDCConMessage = (con: Con | null, { keepOpen = false, channelId = currentChannelId, splitNine = false, mergeImages = false } = {}) => {
    const startedAt = new Date().toISOString();
    const generation = bufferGeneration;
    if (sendingChannels.has(channelId)) return Promise.resolve(false);
    const sending = !keepOpen;
    if (sending) sendingChannels.add(channelId);
    PluginEvents.dispatch({ type: "DCCON_BUFFER_UPDATE", channelId });
    const attempt: SendAttempt = { startedAt, outcome: "진행 중", keepOpen, phase: "작업 대기",
      mode: keepOpen ? "버퍼 누적" : platform.composer?.attachFiles ? "입력창 첨부" : "즉시 전송" };
    const task = (channelTasks.get(channelId) ?? Promise.resolve()).then(async () => {
      lastSendAttempt = attempt;
      try {
        if (generation !== bufferGeneration) { attempt.outcome = "플러그인 종료로 취소"; return false; }
        markSend(attempt, "채널 확인", { hasChannel: Boolean(channelId) });
        if (!channelId) throw new Error("현재 채널을 찾을 수 없습니다.");
        if (splitNine && (con || keepOpen || activeQueue(channelId).length !== 1))
          throw Error("이미지를 정확히 1개 모았을 때만 9개로 나눠 보낼 수 있습니다.");
        if (mergeImages && (con || keepOpen || splitNine || activeQueue(channelId).length < 2 || activeQueue(channelId).length > 3))
          throw Error("이미지 2~3개를 모았을 때만 합쳐 보낼 수 있습니다.");
        if (!con && !activeQueue(channelId).length) return false;
        if (keepOpen && activeQueue(channelId).length >= 9)
          throw new Error("최대 9개까지 모을 수 있습니다. 일반 클릭으로 마지막 콘과 함께 보내세요.");
        markSend(attempt, "캐시 / 이미지 준비");
        const image = con ? await images.getDCConImage(con) : null;
        attempt.imageBytes = image?.size ?? 0;
        if (generation !== bufferGeneration) { attempt.outcome = "플러그인 종료로 취소"; return false; }
        markSend(attempt, "전송 준비");
        let sentCons = [con!];
        if (keepOpen) {
          markSend(attempt, "버퍼 추가");
          updateQueue(channelId, [...activeQueue(channelId), {file: image!, con: con!}]);
          markSend(attempt, "완료", { outcome: "버퍼 누적 완료", queuedCount: activeQueue(channelId).length });
        } else {
          const queued = activeQueue(channelId);
          let files = [...queued.map(entry => entry.file), ...(image ? [image] : [])];
          if (splitNine) {
            markSend(attempt, "이미지 9분할");
            files = await images.splitImageIntoNine(queued[0].file, () => {
              if (generation !== bufferGeneration) throw Error("이미지 분할이 중단되었습니다.");
            });
          }
          if (mergeImages) {
            markSend(attempt, "이미지 합치기");
            files = [await images.getMergedImage(queued, () => {
              if (generation !== bufferGeneration) throw Error("이미지 합치기가 중단되었습니다.");
            })];
          }
          if (platform.composer?.attachFiles) {
            markSend(attempt, "입력창 첨부");
            await platform.composer.attachFiles(files, channelId);
          } else {
            await sendImagesDirectly(files, channelId, attempt);
          }
          if (generation === bufferGeneration) updateQueue(channelId, []);
          sentCons = [...queued.map(entry => entry.con), ...(con ? [con] : [])];
          markSend(attempt, "완료", { outcome: platform.composer?.attachFiles ? "입력창에 전달 완료" : "전송 성공 확인", sentCount: files.length });
        }
        if (sending) {
          let recent = loadData("recent", []);
          for (const item of sentCons) recent = [item, ...recent.filter(entry => entry.path !== item.path)].slice(0, 20);
          saveData("recent", recent);
          PluginEvents.dispatch({ type: "DCCON_RECENT_UPDATE" });
        }
        if (sending) PluginEvents.dispatch({ type: "DCCON_CLOSE", channelId });
        return true;
      } catch (_error) { const error = _error as Failure;
        attempt.outcome = "실패";
        attempt.error = sendErrorDetails(error);
        attempt.updatedAt = new Date().toISOString();
        platform.logger.error("discord-dccon", "Failed to send discord-dccon:", error);
        platform.ui.showToast((platform.composer?.attachFiles ? "디시콘 첨부 실패 (" : "디시콘 전송 실패 (") + attempt.phase + "): " + error.message, { type: "error", timeout: 10000 });
        return false;
      } finally {
        if (sending) sendingChannels.delete(channelId);
        PluginEvents.dispatch({ type: "DCCON_BUFFER_UPDATE", channelId });
      }
    });
    channelTasks.set(channelId, task);
    task.then(() => { if (channelTasks.get(channelId) === task) channelTasks.delete(channelId); });
    return task;
  };
  function inspectInstantSend() {
    if (platform.composer?.attachFiles) return {
      mode: "입력창 첨부 · 직접 전송",
      composerAvailable: platform.composer.available?.() ?? null,
      lastSendAttempt: lastSendAttempt ? structuredClone(lastSendAttempt) : "아직 첨부 시도 없음",
    };
    const report: Record<string, unknown> = platform.discord.inspect();
    report.lastSendAttempt = lastSendAttempt ? structuredClone(lastSendAttempt) : "아직 전송 시도 없음";
    return report;
  }

  return {activeQueue, updateQueue, removeBuffered, sendDCConMessage, sendImagesDirectly, inspectInstantSend,
    isSending: (channelId: string) => sendingChannels.has(channelId),
    isSendingCon: (con: Con) => [...sendingChannels].some(channel => activeQueue(channel).some(entry => entry.con.path === con.path)),
    removeQueuedCon(con: Con) {for (const [channel, entries] of queuedCons) updateQueue(channel, entries.filter(entry => entry.con.path !== con.path));},
    getCurrentChannel: () => currentChannelId,
    setCurrentChannel: (channelId: string) => {currentChannelId = channelId;},
    stop() {bufferGeneration++; queuedCons.clear();}};
}
export type Sending = ReturnType<typeof createSending>;
