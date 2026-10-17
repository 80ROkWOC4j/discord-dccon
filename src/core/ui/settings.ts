import type {Platform} from '../../platform/types.ts';
import type {Failure} from '../types.ts';
import type {PersonalState, CardProps, SavedCardProps, SettingsState} from '../ui-types.ts';
import type {Packs} from '../packs.ts';
import type {Sending} from '../sending.ts';
import type {Personal} from '../personal.ts';
import type {EmbeddingService} from '../services.ts';
import type {Events} from '../events.ts';
import type {MediaUI} from './media.ts';
import {getLocaleStrings as stringsFor} from '../strings.ts';
import {DCConProxyURL} from '../packs.ts';
import metadata from '../../../package.json' with {type: 'json'};
import {checkForUpdate} from '../updates.ts';
const {version} = metadata;
export function createSettingsUI(platform: Platform, { packs, personal, sending, embedding: Embedding, events: PluginEvents, media }: {
  packs: Packs;
  personal: Personal;
  sending: Pick<Sending, "inspectInstantSend">;
  embedding: Pick<EmbeddingService, "enabled" | "status" | "toggle" | "start">;
  events: Events;
  media: MediaUI;
}) {
  const {personalCons, getDCConSearchResult, loadPacks} = packs;
  const {personalURL, preparePersonalCon, storePersonalCon, movePersonalCon, removePersonalCon} = personal;
  const {inspectInstantSend} = sending;
  const {DCConImage, PersonalImage, BufferImage, PackThumbnail, Button} = media;
  const getLocaleStrings = () => stringsFor(platform.discord.locale);
  class PersonalConManager extends platform.react.Component<Record<string, never>, PersonalState> {
    declare disposed: boolean;
    declare controller?: AbortController;
    declare working: boolean;
    declare refresh: () => void;

    constructor(props: Record<string, never>) {
      super(props);
      this.state = {items: personalCons(), open: false, input: "", title: "", prepared: null, busy: false, message: ""};
      this.refresh = () => this.setState({items: personalCons()});
    }
    componentDidMount() { PluginEvents.subscribe("DCCON_PERSONAL_UPDATE", this.refresh); }
    componentWillUnmount() {
      this.disposed = true;
      this.controller?.abort();
      PluginEvents.unsubscribe("DCCON_PERSONAL_UPDATE", this.refresh);
    }
    async work(action: (signal: AbortSignal) => Promise<unknown>) {
      if (this.working) return;
      this.working = true;
      this.controller = new AbortController();
      this.setState({busy: true, message: ""});
      try { await action(this.controller.signal); }
      catch (_error) { const error = _error as Failure; if (!this.disposed) this.setState({message: error.message}); }
      finally { this.working = false; if (!this.disposed) this.setState({busy: false}); }
    }
    open() {
      this.setState({open: true, input: "", title: "", prepared: null});
      return this.work(async signal => {
        let text;
        try {
          try { text = await platform.readClipboardText(); }
          catch { text = await navigator.clipboard.readText(); }
        } catch {
          if (!this.disposed) this.setState({message: "클립보드를 읽지 못했습니다. 이미지 링크를 직접 입력해 주세요."});
          return;
        }
        try { personalURL(text); }
        catch { if (!this.disposed) this.setState({message: "클립보드에 지원되는 링크가 없습니다. 디시콘 또는 아카콘 이미지 링크를 입력해 주세요."}); return; }
        if (signal.aborted) return;
        this.setState({input: text});
        const prepared = await preparePersonalCon(text, signal);
        if (!signal.aborted) this.setState({prepared, message: "클립보드의 이미지입니다. 확인 후 추가해 주세요."});
      });
    }
    add() {
      return this.work(async signal => {
        const prepared = this.state.prepared || await preparePersonalCon(this.state.input, signal);
        if (signal.aborted) return;
        await storePersonalCon(prepared, this.state.title, signal);
        if (!this.disposed) this.setState({open: false, prepared: null, message: "개별 콘에 추가했습니다."});
      });
    }
    render() {
      const h = platform.react.createElement, s = this.state;
      const addButton = () => h("button", {type: "button", className: "dccon-button", "aria-label": "콘 추가", disabled: s.busy || s.open, onClick: () => this.open()}, "+ 콘 추가");
      return h("div", {className: "dccon-personal"},
        h("div", {className: "dccon-list-toolbar"}, h("span", null, `${s.items.length}개 콘`), addButton()),
        s.open && h("form", {className: "dccon-personal-form", onSubmit: event => {event.preventDefault(); this.add();}},
          h("label", null, "이미지 링크", h("input", {value: s.input, disabled: s.busy, placeholder: "디시콘 · 아카콘 이미지 URL", onChange: e => this.setState({input: (e.target as HTMLInputElement).value, prepared: null})})),
          h("label", null, "이름 (선택)", h("input", {value: s.title, disabled: s.busy, maxLength: 100, onChange: e => this.setState({title: (e.target as HTMLInputElement).value})})),
          s.prepared && h("div", {className: "dccon-personal-preview"}, h(BufferImage, {file: s.prepared.file, title: "추가할 콘 미리보기"})),
          h("div", {className: "dccon-personal-actions"},
            h("button", {type: "submit", className: "dccon-button", disabled: s.busy || !s.input.trim()}, s.busy ? "처리 중…" : "추가"),
            h("button", {type: "button", className: "dccon-button", disabled: s.busy, onClick: () => this.setState({open: false, prepared: null, message: ""})}, "취소"))),
        h("p", {role: "status"}, s.busy ? "이미지를 처리하고 있습니다…" : s.message),
        !s.items.length && !s.open && h("div", {className: "dccon-empty-state"},
          "등록된 개별 콘이 없습니다. 이미지 링크로 콘을 추가해 보세요."),
        h("div", {className: "dccon-saved-container"}, s.items.map((con, index) => h(SavedConCard, {
          key: con.path, title: con.title || "개별 콘",
          thumbnail: h(PersonalImage, {con}),
          isFirst: index === 0, isLast: index === s.items.length - 1, disabled: s.busy,
          onMove: direction => this.work(() => movePersonalCon(con, direction)),
          onRemove: () => this.work(() => removePersonalCon(con)),
        }))));
    }
  }
  class DCConCard extends platform.react.Component<CardProps, {isAdding: boolean}> {
    declare adding: boolean;

    constructor(props: CardProps) {
      super(props);

      this.state = {
        isAdding: false,
      };
    }

    render() {
      const { item } = this.props;
      const existingDccon = this.props.savedDccons.find(
        (d) => String(d.info?.package_idx) === String(item.idx)
      );

      const strings = getLocaleStrings();

      return platform.react.createElement(
        "div",
        {
          className: "dccon-card",
        },
        platform.react.createElement("div", {className: "dccon-card-thumbnail"}, platform.react.createElement(DCConImage, {
          src: `${DCConProxyURL}${item.thumbId}`,
          style: { borderRadius: "8px" },
        })),
        platform.react.createElement(
          "div",
          { className: "dccon-card-content" },
          platform.react.createElement("h3", {title: item.name}, item.name),
          platform.react.createElement("span", {title: item.seller}, item.seller),
          platform.react.createElement("div", {className: "dccon-pack-actions"}, platform.react.createElement(Button, {
            text: existingDccon
              ? strings.settings.added
              : this.state.isAdding
              ? strings.settings.adding
              : strings.settings.addDccon,
            disabled: existingDccon !== undefined || this.state.isAdding,
            onClick: async () => {
              if (this.adding || existingDccon) return;
              this.adding = true;
              this.setState({ isAdding: true });

              try {
                const dcconData = await packs.addPack(item.idx);
                this.props.onAdd(dcconData);
                platform.ui.showToast("디시콘이 추가되었습니다.", {
                  type: "success",
                });
              } catch (_err) { const err = _err as Failure;
                platform.logger.error("discord-dccon", "디시콘 추가 실패:", err);
                platform.ui.showToast("디시콘 추가에 실패했습니다.", {
                  type: "error",
                });
              } finally {
                this.adding = false;
                this.setState({ isAdding: false });
              }
            },
            style: {
              marginLeft: "auto",
            },
          }))
        )
      );
    }
  }

  function SavedConCard(props: SavedCardProps) {
    const h = platform.react.createElement;
    return h("div", {className: "dccon-card"}, h("div", {className: "dccon-card-thumbnail"}, props.thumbnail),
      h("div", {className: "dccon-card-content"},
        h("h3", {title: props.title}, props.title),
        h("span", {"aria-hidden": !props.description || undefined}, props.description),
        h("div", {className: "dccon-pack-actions"},
          h("div", {className: "dccon-pack-order", role: "group", "aria-label": props.title + " 순서 조절"},
            ...([[-1, "위로", props.isFirst], [1, "아래로", props.isLast]] as const).map(([direction, label, boundary]) =>
              h("button", {key: direction, type: "button", disabled: props.disabled || boundary,
                "aria-label": props.title + " " + label, onClick: () => props.onMove(direction)}, label))),
          h(Button, {text: getLocaleStrings().settings.remove, color: "dccon-item-error", disabled: props.disabled,
            onClick: props.onRemove, style: {marginLeft: "auto"}}))));
  }
  class EmbeddingEnvironmentPanel extends platform.react.Component<Record<string, never>, {revision?: number}> {
    declare refresh: () => void;

    constructor(props: Record<string, never>) { super(props); this.state = {}; this.refresh = () => this.setState({revision: (this.state.revision || 0) + 1}); }
    componentDidMount() { PluginEvents.subscribe("DCCON_EMBEDDING_UPDATE", this.refresh); }
    componentWillUnmount() { PluginEvents.unsubscribe("DCCON_EMBEDDING_UPDATE", this.refresh); }
    render() {
      const h = platform.react.createElement;
      return h("section", {className: "dccon-embedding-environment"},
        h("div", {className: "dccon-setting-row"},
          h("h3", null, "의미 기반 검색"),
          h("button", {type: "button", role: "switch", className: "dccon-switch", "aria-label": "의미 기반 검색",
            "aria-checked": Embedding.enabled(), onClick: () => Embedding.toggle(!Embedding.enabled())},
            h("span", {"aria-hidden": true}))),
        h("p", null, "디시콘을 감정이나 상황으로 검색합니다."),
        h("p", null, "활성화하면 EmbeddingGemma 2 q4 모델(약 320 MB)과 실행 파일을 다운로드하고 WebGPU로 이미지를 분석합니다."),
        Embedding.enabled() && h("div", {className: "dccon-embedding-progress"},
          h("p", {role: "status"}, `${Embedding.status.phase} ${Embedding.status.file || ""} · ${Embedding.status.completed}/${Embedding.status.total} · 실패 ${Embedding.status.errors}`),
          h("progress", {"aria-label": "디시콘 색인 진행률", max: Math.max(1, Embedding.status.total), value: ["이미지 색인", "준비 완료", "완료 · 일부 실패", "오류", "꺼짐"].includes(Embedding.status.phase) ? Embedding.status.completed : undefined}),
          Embedding.status.error && h("p", {role: "alert"}, Embedding.status.error),
          ["오류", "꺼짐", "완료 · 일부 실패"].includes(Embedding.status.phase) && h(Button, {text: "다시 시도", onClick: () => Embedding.start()})));
    }
  }

  class UpdatePanel extends platform.react.Component<Record<string, never>, {busy: boolean; message: string}> {
    controller?: AbortController;
    timer?: ReturnType<typeof setTimeout>;
    constructor(props: Record<string, never>) {super(props); this.state = {busy: false, message: ''};}
    componentWillUnmount() {this.controller?.abort(); this.controller = undefined; clearTimeout(this.timer);}
    async check() {
      if (this.controller) return;
      const controller = this.controller = new AbortController();
      this.setState({busy: true, message: ''});
      this.timer = setTimeout(() => controller.abort(), 15000);
      try {
        const result = await checkForUpdate(platform.net, version, controller.signal);
        if (this.controller !== controller) return;
        this.setState({message: result.available ? `업데이트할 수 있습니다. 최신 버전: ${result.latestVersion}`
          : result.latestVersion ? '새로운 업데이트가 없습니다.' : '확인할 수 있는 공개 릴리스가 없습니다.'});
      } catch (_error) {
        if (this.controller !== controller) return;
        this.setState({message: controller.signal.aborted ? '확인 시간이 초과되었습니다. 다시 시도해 주세요.'
          : _error instanceof Error ? _error.message : '업데이트 확인에 실패했습니다. 네트워크 연결을 확인하고 다시 시도해 주세요.'});
      } finally {
        clearTimeout(this.timer);
        if (this.controller === controller) {this.controller = undefined; this.setState({busy: false});}
      }
    }
    render() {
      const h = platform.react.createElement;
      return h('section', {className: 'dccon-update'},
        h('div', {className: 'dccon-update-row'},
          h('div', {className: 'dccon-update-version'}, h('h3', null, '현재 버전'), h('span', null, `v${version}`)),
          h(Button, {text: this.state.busy ? '확인 중…' : '업데이트 확인', disabled: this.state.busy, onClick: () => this.check()})),
        h('p', {role: 'status'}, this.state.message));
    }
  }

  // 설정 패널 컴포넌트
  let lastManagementTab = "shop";
  class DCConSettingsPanel extends platform.react.Component<{section?: string}, SettingsState> {
    declare reportInput: HTMLTextAreaElement | null;

    constructor(props: {section?: string}) {
      super(props);

      this.state = {
        activeTab: lastManagementTab,
        searchQuery: "",
        searchResults: [],
        isSearching: false,
        savedDccons: loadPacks(),
      };

      this.handleSearch = this.handleSearch.bind(this);
      this.handleTabChange = this.handleTabChange.bind(this);
    }

    async handleSearch() {
      if (this.state.searchQuery.trim() === "") return;

      this.setState({ isSearching: true });

      try {
        const results = await getDCConSearchResult(this.state.searchQuery);
        this.setState({ searchResults: results });
      } catch (_err) { const err = _err as Failure;
        platform.logger.error("discord-dccon", "디시콘 검색 실패:", err);
        platform.ui.showToast("디시콘 검색에 실패했습니다.", { type: "error" });
      }

      this.setState({ isSearching: false });
    }

    handleTabChange(tab: string) {
      lastManagementTab = tab;
      this.setState({ activeTab: tab });
    }

    renderSearch() {
      const strings = getLocaleStrings();

      return platform.react.createElement(
        "div",
        { className: "dccon-search-container" },
        platform.react.createElement(
          "div",
          { className: "dccon-list-toolbar dccon-search-bar" },
          platform.react.createElement("input", {
            type: "text",
            placeholder: strings.settings.searchDccon,
            value: this.state.searchQuery,
            onChange: (e) => this.setState({ searchQuery: (e.target as HTMLInputElement).value }),
            onKeyDown: (e) => {
              if (e.key === "Enter") this.handleSearch();
            },
          }),
          platform.react.createElement(Button, {
            text: this.state.isSearching ? "검색 중…" : "검색",
            disabled:
              this.state.isSearching || this.state.searchQuery.trim() === "",
            onClick: this.handleSearch,
          })
        ),
        platform.react.createElement(
          "div",
          { className: "dccon-search-results" },
          this.state.searchResults.length > 0
            ? this.state.searchResults.map((result) =>
                platform.react.createElement(DCConCard, {
                  key: result.idx,
                  item: result,
                  savedDccons: this.state.savedDccons,
                  onAdd: () => {
                    this.setState({ savedDccons: loadPacks() });
                  },
                })
              )
            : this.state.searchQuery !== "" && !this.state.isSearching
            ? platform.react.createElement(
                "div",
                { className: "dccon-empty-state" },
                strings.settings.noResults
              )
            : null
        )
      );
    }

    renderDiagnostics() {
      const h = platform.react.createElement;
      return h("div", { className: "dccon-diagnostics" },
        h("h3", null, "문제 해결 · 버그 제보"),
        h("p", null, "디시콘이 보내지지 않거나 오류가 발생했나요? 문제가 발생한 직후 진단 정보를 만들어 제보에 첨부해 주세요."),
        h("ol", {className: "dccon-report-steps"},
          h("li", null, "문제가 발생한 조작과 기대했던 동작을 적어 주세요."),
          h("li", null, "아래에서 진단 정보를 생성하고 복사해 주세요."),
          h("li", null, "복사한 정보와 재현 순서를 버그 제보에 함께 붙여넣어 주세요.")),
        h("p", null, "진단은 자동으로 제출되지 않으며, 메시지를 보내거나 입력 중인 내용을 변경하지 않습니다."),
        h(Button, { text: this.state.diagnosticReport ? "진단 정보 새로고침" : "진단 정보 만들기", onClick: () => {
          const report = inspectInstantSend();
          this.setState({ diagnosticReport: JSON.stringify({ pluginVersion: version, generatedAt: new Date().toISOString(), ...report }, null, 2),
            copyStatus: "" });
        } }),
        this.state.diagnosticReport && h("div", null,
          h("textarea", { className: "dccon-diagnostic-report", "aria-label": "진단 결과", readOnly: true,
            value: this.state.diagnosticReport, ref: element => { this.reportInput = element as HTMLTextAreaElement | null; }, onFocus: event => (event.target as HTMLTextAreaElement).select(),
          }),
          h(Button, { text: "제보용 정보 복사", onClick: async () => {
            this.reportInput?.focus();
            this.reportInput?.select();
            try {
              await navigator.clipboard.writeText(this.state.diagnosticReport!);
              this.setState({ copyStatus: "복사했습니다. 버그 제보에 재현 순서와 함께 붙여넣어 주세요." });
            } catch {
              this.setState({ copyStatus: "결과를 선택했습니다. Ctrl+C로 복사해 주세요." });
            }
          } }),
          h("p", { role: "status" }, this.state.copyStatus || "제보 전에 내용을 확인해 주세요. 계정 토큰이나 인증 정보는 추가하지 마세요.")
        )
      );
    }

    renderSaved() {
      const h = platform.react.createElement;
      const addButton = () => h("button", {type: "button", className: "dccon-button", onClick: () => this.handleTabChange("shop")}, "+ 팩 추가");
      return h("div", null,
        h("div", {className: "dccon-list-toolbar"}, h("span", null, `${this.state.savedDccons.length}개 팩`), addButton()),
      platform.react.createElement(
        "div",
        { className: "dccon-saved-container" },
        this.state.savedDccons.length > 0
          ? this.state.savedDccons.map((dccon, index) =>
              platform.react.createElement(SavedConCard, {
                key: dccon.info.package_idx,
                title: dccon.info.title,
                thumbnail: platform.react.createElement(PackThumbnail, {pack: dccon, style: {borderRadius: "8px"}}),
                description: `${dccon.detail.length}개의 디시콘`,
                isFirst: index === 0,
                isLast: index === this.state.savedDccons.length - 1,
                onMove: direction => {
                  const reordered = packs.movePack(dccon.info.package_idx, direction);
                  if (reordered) this.setState({savedDccons: reordered});
                },
                onRemove: () => {
                  packs.removePack(dccon.info.package_idx);
                  this.setState({ savedDccons: loadPacks() });
                  platform.ui.showToast("디시콘이 제거되었습니다.", {type: "success"});
                },
              })
            )
          : platform.react.createElement(
              "div",
              { className: "dccon-empty-state" },
              "추가된 디시콘이 없습니다. 디시콘샵에서 팩을 추가해 보세요."
            )
      ));
    }

    render() {
      const h = platform.react.createElement;
      if (this.props.section === "settings") {
        return h("div", {className: "dccon-settings-panel dccon-user-settings"},
          h(UpdatePanel), h(EmbeddingEnvironmentPanel), this.renderDiagnostics());
      }
      return h("div", {className: "dccon-settings-panel"},
        h("div", {className: "dccon-tab-menu"},
          ...[["shop", "디시콘샵"], ["saved", "보관한 팩"], ["personal", "개별 콘"]].map(([tab, label]) => h("button", {
            key: tab, type: "button", className: "dccon-tab-item " + (this.state.activeTab === tab ? "active" : ""),
            onClick: () => this.handleTabChange(tab),
          }, label))),
        h("div", {className: "dccon-tab-content"}, this.state.activeTab === "saved" ? this.renderSaved() : this.state.activeTab === "personal" ? h(PersonalConManager) : this.renderSearch()));
    }

  }
  // #endregion

  return {PersonalConManager, DCConCard, SavedConCard, EmbeddingEnvironmentPanel, DCConSettingsPanel};
}
export type SettingsUI = ReturnType<typeof createSettingsUI>;
