import type {Platform} from '../../platform/types.ts';
import type * as React from 'react';
import type {Failure, Pack} from '../types.ts';
import type {ChannelProps, ItemProps, PanelProps, PanelState} from '../ui-types.ts';
import type {SettingsService} from '../settings.ts';
import type {Packs} from '../packs.ts';
import type {Images} from '../images.ts';
import type {Sending} from '../sending.ts';
import type {EmbeddingService} from '../services.ts';
import type {Events} from '../events.ts';
import type {MediaUI} from './media.ts';
import {getLocaleStrings as stringsFor} from '../strings.ts';
import {DCConProxyURL} from '../packs.ts';
export function createPickerUI(platform: Platform, { settings, packs, images, sending, embedding: Embedding, events: PluginEvents, media }: {
  settings: Pick<SettingsService, "loadData">;
  packs: Packs;
  images: Pick<Images, "mergeImageReason">;
  sending: Pick<Sending, "activeQueue" | "removeBuffered" | "sendDCConMessage" | "isSending">;
  embedding: Pick<EmbeddingService, "enabled" | "status" | "cancelSearch" | "search" | "key">;
  events: Events;
  media: MediaUI;
}) {
  const {loadData} = settings;
  const {pickerPacks, personalCons} = packs;
  const {activeQueue, removeBuffered, sendDCConMessage} = sending;
  const {DCConImage, PersonalImage, BufferImage, PackThumbnail, ManduIcon} = media;
  const getLocaleStrings = () => stringsFor(platform.discord.locale);
  class BufferTray extends platform.react.Component<ChannelProps, {mergeReady: boolean; mergeReason: string}> {
    declare mergeSequence: number;
    declare mergeFiles?: File[];
    declare refresh: () => void;

    constructor(props: ChannelProps) {
      super(props);
      this.state = {mergeReady: false, mergeReason: "이미지 2~3개를 모아 주세요."};
      this.mergeSequence = 0;
      this.refresh = () => {this.forceUpdate(); this.checkMerge();};
    }
    componentDidMount() { PluginEvents.subscribe("DCCON_BUFFER_UPDATE", this.refresh); this.checkMerge(); }
    componentDidUpdate(previous: ChannelProps) {if (previous.channelId !== this.props.channelId) this.checkMerge();}
    componentWillUnmount() {this.mergeSequence++; PluginEvents.unsubscribe("DCCON_BUFFER_UPDATE", this.refresh);}
    checkMerge() {
      const files = activeQueue(this.props.channelId).map(entry => entry.file);
      if (this.mergeFiles?.length === files.length && files.every((file, index) => file === this.mergeFiles![index])) return;
      this.mergeFiles = files;
      const sequence = ++this.mergeSequence;
      this.setState({mergeReady: false, mergeReason: "이미지 정보 확인 중…"});
      images.mergeImageReason(files).then(reason => {
        if (sequence === this.mergeSequence) this.setState({mergeReady: !reason, mergeReason: reason});
      }, () => {
        if (sequence === this.mergeSequence) this.setState({mergeReady: false, mergeReason: "이미지 정보를 읽지 못했습니다."});
      });
    }
    render() {
      const h = platform.react.createElement;
      const channelId = this.props.channelId;
      const entries = activeQueue(channelId);
      const busy = sending.isSending(channelId);
      if (!entries.length && !busy) return null;
      return h("section", { className: "dccon-buffer", "aria-label": "전송 대기 디시콘", "data-count": entries.length },
        h("div", { className: "dccon-buffer-heading" },
          h("span", {role: "status"}, busy ? (platform.composer?.attachFiles ? "첨부 중…" : "전송 중…") : "모아둔 콘 " + entries.length + "/9"),
          h("div", {className: "dccon-buffer-actions"},
            h("button", {type: "button", disabled: busy, onClick: () => removeBuffered(channelId)}, "전체 비우기"),
            h("button", {type: "button", className: "dccon-buffer-send", disabled: busy || !entries.length,
              onClick: () => sendDCConMessage(null, {channelId})}, platform.composer?.attachFiles ? "입력창에 첨부" : "전송"))),
        h("div", {className: "dccon-buffer-preview"},
          h("div", {className: "dccon-buffer-items", "data-count": entries.length}, entries.map((entry, index) => h("button", {
          key: index, type: "button", disabled: busy, title: entry.con.title + " 제거",
          "aria-label": entry.con.title + " 제거", onClick: () => removeBuffered(channelId, entry),
        }, h("div", {className: "dccon-buffer-media"}, h(BufferImage, {file: entry.file, title: entry.con.title})),
          h("span", {className: "dccon-buffer-order", "aria-hidden": true}, index + 1),
          h("span", {className: "dccon-buffer-remove", "aria-hidden": true}, "×"))))),
        h("button", {type: "button", className: "dccon-buffer-split", disabled: busy || entries.length !== 1,
          title: "이미지 1개를 3×3으로 나눕니다. 애니메이션은 유지됩니다.",
          onClick: () => sendDCConMessage(null, {channelId, splitNine: true})}, platform.composer?.attachFiles ? "9개로 쪼개서 첨부" : "9개로 쪼개서 보내기"),
        h("button", {type: "button", className: "dccon-buffer-merge", disabled: busy || !this.state.mergeReady,
          title: this.state.mergeReason || "선택 순서대로 가로로 이어붙입니다. 원본 크기와 애니메이션을 유지합니다.",
          onClick: () => sendDCConMessage(null, {channelId, mergeImages: true})}, platform.composer?.attachFiles ? "합쳐서 첨부" : "합쳐서 전송"),
        this.state.mergeReason && h("p", {className: "dccon-buffer-merge-reason", role: "status"}, this.state.mergeReason),
        h("p", {className: "dccon-buffer-hint"}, platform.composer?.attachFiles
          ? "일반 클릭은 콘을 하나 더 추가해 입력창에 첨부합니다. Discord에서 직접 전송하세요."
          : "예상 배치 · 기기마다 크기는 달라질 수 있어요. 일반 클릭은 콘을 하나 더 추가해 전송합니다."));
    }
  }
  class DCConCategory extends platform.react.Component<{dccon: Pack}, {expanded: boolean}> {

    constructor(props: {dccon: Pack}) {
      super(props);
      this.state = {
        expanded: !loadData("collapsedPacks", {})[String(props.dccon.info.package_idx)],
      };
    }

    render() {
      const { dccon } = this.props;
      const strings = getLocaleStrings();

      return platform.react.createElement(
        "div",
        { className: "dccon-category" },
        platform.react.createElement(
          "button",
          {
            type: "button",
            "aria-expanded": this.state.expanded,
            className: `dccon-category-header ${
              this.state.expanded ? "expanded" : "collapsed"
            }`,
            onClick: () => {
              const expanded = !this.state.expanded;
              packs.setExpanded(dccon.info.package_idx, expanded);
              this.setState({ expanded });
            },
          },
          platform.react.createElement(PackThumbnail, {
            pack: dccon,
            className: "dccon-category-icon",
          }),
          platform.react.createElement(
            "div",
            { className: "dccon-category-name" },
            dccon.info.title
          ),
          platform.react.createElement(
            "div",
            { className: "dccon-category-toggle" },
            platform.react.createElement(
              "svg",
              {
                width: "24",
                height: "24",
                viewBox: "0 0 24 24",
              },
              platform.react.createElement("path", {
                fill: "currentColor",
                d: this.state.expanded
                  ? "M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"
                  : "M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z",
              })
            )
          )
        ),
        this.state.expanded &&
          platform.react.createElement(
            "div",
            { className: "dccon-items" },
            dccon.detail.map((con) =>
              platform.react.createElement(DCConItem, {
                key: con.idx,
                con: con,
                packageIdx: dccon.info.package_idx,
              })
            )
          )
      );
    }
  }

  // 디시콘 아이템 컴포넌트
  class DCConItem extends platform.react.Component<ItemProps, {error: boolean; busy: boolean; favorite: boolean}> {
    declare refreshFavorite: () => void;
    declare sending: boolean;
    declare press?: {id: number; x: number; y: number; timer?: ReturnType<typeof setTimeout>};
    declare suppressClick: boolean;
    declare touchInteraction: boolean;

    constructor(props: ItemProps) {
      super(props);
      this.state = { error: false, busy: false, favorite: loadData("favorites", []).some(con => con.path === props.con.path) };
      this.refreshFavorite = () => this.setState({ favorite: loadData("favorites", []).some(con => con.path === this.props.con.path) });
    }

    componentDidMount() { PluginEvents.subscribe("DCCON_FAVORITES_UPDATE", this.refreshFavorite); }
    componentWillUnmount() { this.cancelPress(); PluginEvents.unsubscribe("DCCON_FAVORITES_UPDATE", this.refreshFavorite); }

    cancelPress() {
      clearTimeout(this.press?.timer);
      this.press = undefined;
    }

    startPress(event: React.PointerEvent) {
      this.cancelPress();
      this.suppressClick = false;
      this.touchInteraction = event.pointerType === "touch";
      if (!this.touchInteraction) return;
      if (!event.isPrimary || event.button !== 0 || this.state.busy || this.state.error) {this.suppressClick = true; return;}
      this.press = {id: event.pointerId, x: event.clientX, y: event.clientY,
        timer: setTimeout(() => this.collectPress(), 450)};
    }

    collectPress() {
      if (!this.press || this.suppressClick) return;
      clearTimeout(this.press.timer);
      this.press.timer = undefined;
      this.suppressClick = true;
      void this.attach(true);
    }

    movePress(event: React.PointerEvent) {
      if (this.press?.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) > 10) {
        this.suppressClick = true;
        this.cancelPress();
      }
    }

    endPress(event: React.PointerEvent, cancelled = false) {
      if (this.press?.id !== event.pointerId) return;
      if (cancelled) this.suppressClick = true;
      this.cancelPress();
    }

    toggleFavorite() {
      const con = { ...this.props.con, packageIdx: this.props.packageIdx };
      packs.toggleFavorite(con);
    }

    async attach(keepOpen: boolean) {
      if (this.sending) return;
      this.sending = true;
      this.setState({ busy: true });
      try {
        await sendDCConMessage({ ...this.props.con, packageIdx: this.props.packageIdx }, { keepOpen });
      } finally {
        this.sending = false;
        this.setState({ busy: false });
      }
    }

    render() {
      const h = platform.react.createElement;
      const { con } = this.props;
      return h("div", { className: "dccon-tile" },
        h("button", { type: "button", title: con.title + " · 길게 누르기 / Shift+클릭: 이미지 모아두기",
          "aria-label": con.title, className: "dccon-item", disabled: this.state.busy || this.state.error,
          onPointerDown: event => this.startPress(event),
          onPointerMove: event => this.movePress(event),
          onPointerUp: event => this.endPress(event),
          onPointerCancel: event => this.endPress(event, true),
          onPointerLeave: event => this.endPress(event, true),
          onContextMenu: event => {
            if (!this.touchInteraction) return;
            event.preventDefault(); event.stopPropagation();
            this.collectPress();
          },
          onKeyDown: () => {this.cancelPress(); this.suppressClick = false; this.touchInteraction = false;},
          onClick: event => {
            if (this.suppressClick) {event.preventDefault(); event.stopPropagation(); this.suppressClick = false; return;}
            void this.attach(event.shiftKey);
          },
        }, this.state.error ? h("span", { className: "dccon-item-error" }, "이미지 로드 실패")
          : con.path.startsWith("personal:") ? h(PersonalImage, {con, onError: () => this.setState({error: true})})
          : h(DCConImage, { src: DCConProxyURL + con.path, alt: con.title, loading: "lazy", onError: () => this.setState({ error: true }) }),
          this.state.busy && h("span", { className: "dccon-loading", role: "status" }, "처리 중…")
        ),
        h("button", { type: "button", className: "dccon-favorite", "aria-label": this.state.favorite ? "즐겨찾기 해제" : "즐겨찾기 추가",
          title: this.state.favorite ? "즐겨찾기 해제" : "즐겨찾기 추가", "aria-pressed": this.state.favorite, onClick: () => this.toggleFavorite(),
        }, this.state.favorite ? "★" : "☆")
      );
    }
  }

  // 디시콘 패널 컴포넌트 업데이트
  class DCConPanel extends platform.react.Component<PanelProps, PanelState> {
    declare personalRefresh: () => void;
    declare clearSearch: () => void;
    declare refresh: () => void;
    declare embeddingRefresh: () => void;
    declare mounted: boolean;
    declare searchGeneration: number;
    declare searchTimer?: ReturnType<typeof setTimeout>;
    declare embeddingPhase: string;
    declare content: HTMLDivElement | null;

    constructor(props: PanelProps) {
      super(props);
      this.state = { textFilter: "", selected: "all", dccons: pickerPacks() };
      this.personalRefresh = () => {
        this.setState({dccons: pickerPacks(), semanticResults: (this.state.semanticResults || []).filter(({con}) =>
          !con.path.startsWith("personal:") || personalCons().some(item => item.path === con.path))});
      };
      this.clearSearch = () => this.changeSearch("");
      this.refresh = () => this.setState({ revision: (this.state.revision ?? 0) + 1 });
      this.embeddingRefresh = () => {
        this.refresh();
        const phase = Embedding.status.phase;
        if (!Embedding.enabled() || (phase !== this.embeddingPhase && ["이미지 색인", "준비 완료", "완료 · 일부 실패"].includes(phase))) this.changeSearch(this.state.textFilter);
        this.embeddingPhase = phase;
      };
    }

    componentDidMount() {
      PluginEvents.subscribe("DCCON_PERSONAL_UPDATE", this.personalRefresh);
      PluginEvents.subscribe("DCCON_FAVORITES_UPDATE", this.refresh);
      PluginEvents.subscribe("DCCON_RECENT_UPDATE", this.refresh);
      this.mounted = true;
      PluginEvents.subscribe("DCCON_EMBEDDING_UPDATE", this.embeddingRefresh);
    }

    componentWillUnmount() {
      PluginEvents.unsubscribe("DCCON_PERSONAL_UPDATE", this.personalRefresh);
      PluginEvents.unsubscribe("DCCON_FAVORITES_UPDATE", this.refresh);
      PluginEvents.unsubscribe("DCCON_RECENT_UPDATE", this.refresh);
      this.mounted = false; clearTimeout(this.searchTimer); this.searchGeneration = (this.searchGeneration || 0) + 1;
      Embedding.cancelSearch();
      PluginEvents.unsubscribe("DCCON_EMBEDDING_UPDATE", this.embeddingRefresh);
    }

    changeSearch(text: string) {
      clearTimeout(this.searchTimer);
      Embedding.cancelSearch();
      const generation = this.searchGeneration = (this.searchGeneration || 0) + 1;
      const semantic = Embedding.enabled() && text.trim();
      this.setState({textFilter: text, semanticResults: [], searchError: "", searching: Boolean(semantic)});
      if (!semantic) return;
      this.searchTimer = setTimeout(async () => {
        try {
          const semanticResults = await Embedding.search(text.trim());
          if (this.mounted && generation === this.searchGeneration) this.setState({semanticResults, searching: false});
        } catch (_error) { const error = _error as Failure;
          if (this.mounted && generation === this.searchGeneration) this.setState({searchError: String(error.message), searching: false});
        }
      }, 350);
    }

    filterDccons() {
      const query = this.state.textFilter.trim().toLowerCase();
      return this.state.dccons
        .filter(pack => this.state.selected === "all" || String(pack.info.package_idx) === this.state.selected)
        .map(pack => ({ ...pack, detail: !query || pack.info.title.toLowerCase().includes(query)
          ? pack.detail : pack.detail.filter(con => con.title.toLowerCase().includes(query)) }))
        .filter(pack => pack.detail.length > 0);
    }

    render() {
      if (this.props.type !== "dccon") return null;
      const h = platform.react.createElement;
      const packs = this.filterDccons();
      const query = this.state.textFilter.trim().toLowerCase();
      const isFavorites = this.state.selected === "favorites";
      const semantic = Embedding.enabled() && Boolean(query);
      const semanticResults = (this.state.semanticResults || []).filter(({con}) => {
        if (this.state.selected === "all") return true;
        if (["favorites", "recent"].includes(this.state.selected)) return loadData(this.state.selected as "favorites" | "recent", []).some(item => item.path === con.path);
        return String(con.packageIdx) === this.state.selected;
      }).slice(0, 60);
      const recent = loadData(isFavorites ? "favorites" : "recent", []).filter(con => !query || con.title.toLowerCase().includes(query));
      const select = (id: string) => {
        this.setState({ selected: id });
        this.content?.scrollTo?.({ top: 0 });
      };
      const navButton = (id: string, label: string, child: React.ReactNode) => h("button", {
        key: id, type: "button", className: "dccon-rail-button",
        title: label, "aria-label": label, "aria-pressed": this.state.selected === id,
        onClick: () => select(id),
      }, child);
      return h("div", { className: "dccon-pickerContainer" },
        h("div", { className: "dccon-header" },
          h("div", { className: "dccon-search-field" },
            h("svg", { "aria-hidden": true, width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2 },
              h("circle", { cx: 10, cy: 10, r: 6 }), h("path", { d: "m15 15 6 6" })),
            h("input", { className: "dccon-search-input", "aria-label": "디시콘 검색", placeholder: Embedding.enabled() ? "표정이나 상황으로 검색하기" : "디시콘 이름이나 팩 검색하기",
              autoFocus: !window.matchMedia?.("(any-pointer: coarse)").matches, value: this.state.textFilter,
              onChange: e => this.changeSearch((e.target as HTMLInputElement).value),
            }),
            this.state.textFilter && h("button", { type: "button", "aria-label": "검색 지우기", onClick: this.clearSearch }, "×")
          )
        ),
        h("div", { className: "dccon-browser" },
          h("nav", { className: "dccon-rail", "aria-label": "디시콘 팩" },
            navButton("all", "전체 디시콘", h(ManduIcon)),
            navButton("recent", "최근 사용", "◷"),
            navButton("favorites", "즐겨찾기", "★"),
            h("div", { className: "dccon-rail-divider" }),
            ...this.state.dccons.map(pack => navButton(String(pack.info.package_idx), pack.info.title,
              h(PackThumbnail, { pack }))),
            h("button", { type: "button", className: "dccon-rail-button", "aria-label": "팩 추가 / 관리", title: "팩 추가 / 관리", onClick: this.props.onManage }, "+")
          ),
          h("div", { className: "dccon-browser-content", ref: element => { this.content = element as HTMLDivElement | null; } },
            semantic ? h("section", null,
              h("h3", {className: "dccon-section-title"}, "의미 기반 검색"),
              h("p", {role: "status"}, this.state.searching ? "검색 중…" : this.state.searchError || `완료된 색인에서 ${semanticResults.length}개 결과`),
              h("div", {className: "dccon-items"}, semanticResults.map(({con}) => h(DCConItem, {key: Embedding.key(con), con, packageIdx: con.packageIdx}))))
            : (this.state.selected === "recent" || isFavorites)
              ? h("section", null, h("h3", { className: "dccon-section-title" }, isFavorites ? "즐겨찾기" : "최근 사용"),
                  recent.length ? h("div", { className: "dccon-items" }, recent.map(con => h(DCConItem, { key: con.idx, con, packageIdx: con.packageIdx })))
                    : h("div", { className: "dccon-empty-state", role: "status" }, query ? "검색 결과가 없습니다." : isFavorites ? "콘의 ☆ 버튼으로 즐겨찾기를 추가하세요." : "사용한 디시콘이 여기에 표시됩니다."))
              : packs.length ? packs.map(pack => h(DCConCategory, { key: pack.info.package_idx, dccon: pack }))
                : h("div", { className: "dccon-empty-state", role: "status" },
                    this.state.dccons.length ? "검색 결과가 없습니다. 다른 이름으로 검색해 보세요." : "아직 등록한 디시콘이 없습니다.",
                    !this.state.dccons.length && h("button", { type: "button", onClick: this.props.onManage }, "팩 추가하기"))
          )
        ),
        h("div", { className: "dccon-footer" }, h("span", {className: "dccon-desktop-hint"}, platform.composer?.attachFiles
          ? "탭/클릭: 입력창에 첨부 · 길게 누르기/Shift+클릭: 모아두기 · 전송은 Discord에서 직접"
          : "탭/클릭: 누적 콘과 함께 전송 · 길게 누르기/Shift+클릭: 모아두기 (최대 9개)"),
          h("span", {className: "dccon-compact-hint"}, platform.composer?.attachFiles
            ? "길게 눌러 모으기 · 탭하여 입력창에 첨부" : "길게 눌러 모으기 · 탭하여 전송"))
      );
    }
  }

  return {BufferTray, DCConCategory, DCConItem, DCConPanel};
}
export type PickerUI = ReturnType<typeof createPickerUI>;
