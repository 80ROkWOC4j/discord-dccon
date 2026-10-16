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
export function createSettingsUI(platform: Platform, { packs, personal, sending, embedding: Embedding, events: PluginEvents, media }: {
  packs: Packs;
  personal: Personal;
  sending: Pick<Sending, "inspectInstantSend">;
  embedding: Pick<EmbeddingService, "enabled" | "status" | "toggle" | "start">;
  events: Events;
  media: MediaUI;
}) {
  const {personalCons, getDCConSearchResult, loadPacks} = packs;
  const {personalURL, preparePersonalCon, storePersonalCon, removePersonalCon} = personal;
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
      return h("div", {className: "dccon-personal"},
        h("button", {type: "button", className: "dccon-button", disabled: s.busy, onClick: () => this.open()}, "콘 추가"),
        s.open && h("form", {className: "dccon-personal-form", onSubmit: event => {event.preventDefault(); this.add();}},
          h("label", null, "이미지 링크", h("input", {value: s.input, disabled: s.busy, placeholder: "디시콘 · 아카콘 이미지 URL", onChange: e => this.setState({input: (e.target as HTMLInputElement).value, prepared: null})})),
          h("label", null, "이름 (선택)", h("input", {value: s.title, disabled: s.busy, maxLength: 100, onChange: e => this.setState({title: (e.target as HTMLInputElement).value})})),
          s.prepared && h("div", {className: "dccon-personal-preview"}, h(BufferImage, {file: s.prepared.file, title: "추가할 콘 미리보기"})),
          h("div", {className: "dccon-personal-actions"},
            h("button", {type: "submit", className: "dccon-button", disabled: s.busy || !s.input.trim()}, s.busy ? "처리 중…" : "추가"),
            h("button", {type: "button", className: "dccon-button", disabled: s.busy, onClick: () => this.setState({open: false, prepared: null, message: ""})}, "취소"))),
        h("p", {role: "status"}, s.busy ? "이미지를 처리하고 있습니다…" : s.message),
        !s.items.length && h("p", null, "개별 이미지를 등록하면 내 디시콘의 ‘개별 콘’에서 사용할 수 있습니다."),
        ...s.items.map(con => h("div", {className: "dccon-card", key: con.path},
          h("div", {className: "dccon-personal-preview"}, h(PersonalImage, {con})),
          h("div", {className: "dccon-card-content"}, h("h3", null, con.title)),
          h("button", {type: "button", className: "dccon-button", disabled: s.busy, onClick: () => this.work(() => removePersonalCon(con))}, "제거"))));
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
        platform.react.createElement(DCConImage, {
          src: `${DCConProxyURL}${item.thumbId}`,
          style: { borderRadius: "8px" },
        }),
        platform.react.createElement(
          "div",
          { className: "dccon-card-content" },
          platform.react.createElement("h3", {}, item.name),
          platform.react.createElement("span", {}, item.seller),
          platform.react.createElement(Button, {
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
              marginTop: "auto",
              marginLeft: "auto",
            },
          })
        )
      );
    }
  }

  // 저장된 디시콘 카드 컴포넌트 (추가된 디시콘 관리용)
  class SavedDCConCard extends platform.react.Component<SavedCardProps, Record<string, never>> {

    render() {
      const { dccon } = this.props;
      const strings = getLocaleStrings();

      return platform.react.createElement(
        "div",
        {
          className: "dccon-card",
        },
        platform.react.createElement(PackThumbnail, {
          pack: dccon,
          style: { borderRadius: "8px" },
        }),
        platform.react.createElement(
          "div",
          { className: "dccon-card-content" },
          platform.react.createElement("h3", {}, dccon.info.title),
          platform.react.createElement(
            "span",
            {},
            `${dccon.detail.length}개의 디시콘`
          ),
          platform.react.createElement("div", {className: "dccon-pack-actions"},
          platform.react.createElement("div", {className: "dccon-pack-order", role: "group", "aria-label": dccon.info.title + " 순서 조절"},
            ...([[-1, "위로", this.props.isFirst], [1, "아래로", this.props.isLast]] as const).map(([direction, label, disabled]) =>
              platform.react.createElement("button", {key: direction, type: "button", disabled,
                "aria-label": dccon.info.title + " " + label, onClick: () => this.props.onMove(direction)}, label))),
          platform.react.createElement(Button, {
            text: strings.settings.remove,
            color: "dccon-item-error",
            onClick: () => {
              packs.removePack(dccon.info.package_idx);
              this.props.onRemove(dccon.info.package_idx);
              platform.ui.showToast("디시콘이 제거되었습니다.", { type: "success" });
            },
            style: {
              marginLeft: "auto",
            },
          }))
        )
      );
    }
  }
  class EmbeddingEnvironmentPanel extends platform.react.Component<Record<string, never>, {revision?: number}> {
    declare refresh: () => void;

    constructor(props: Record<string, never>) { super(props); this.state = {}; this.refresh = () => this.setState({revision: (this.state.revision || 0) + 1}); }
    componentDidMount() { PluginEvents.subscribe("DCCON_EMBEDDING_UPDATE", this.refresh); }
    componentWillUnmount() { PluginEvents.unsubscribe("DCCON_EMBEDDING_UPDATE", this.refresh); }
    render() {
      const h = platform.react.createElement;
      return h("section", {className: "dccon-embedding-environment"},
        h("h3", null, "디시콘 임베딩"),
        h("label", null, h("input", {type: "checkbox", checked: Embedding.enabled(), onChange: e => Embedding.toggle(e.target.checked)}), " 의미 기반 검색 활성화"),
        h("p", null, "활성화하면 EmbeddingGemma 2 모델(약 550 MB)을 다운로드하고 WebGPU로 이미지를 임베딩 합니다."),
        Embedding.enabled() && h("div", {className: "dccon-embedding-progress"},
          h("p", {role: "status"}, `${Embedding.status.phase} ${Embedding.status.file || ""} · ${Embedding.status.completed}/${Embedding.status.total} · 실패 ${Embedding.status.errors}`),
          h("progress", {"aria-label": "디시콘 색인 진행률", max: Math.max(1, Embedding.status.total), value: ["이미지 색인", "준비 완료", "완료 · 일부 실패", "오류", "꺼짐"].includes(Embedding.status.phase) ? Embedding.status.completed : undefined}),
          Embedding.status.error && h("p", {role: "alert"}, Embedding.status.error),
          ["오류", "꺼짐", "완료 · 일부 실패"].includes(Embedding.status.phase) && h(Button, {text: "다시 시도", onClick: () => Embedding.start()})),
        h("p", null, "모델은 공통 캐시의 models, 벡터는 vectors 아래에 보관됩니다. 비활성화 하면 작업 중단합니다."));
    }
  }

  // 설정 패널 컴포넌트
  class DCConSettingsPanel extends platform.react.Component<{section?: string}, SettingsState> {
    declare reportInput: HTMLTextAreaElement | null;

    constructor(props: {section?: string}) {
      super(props);

      this.state = {
        activeTab: "saved",
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
      this.setState({ activeTab: tab });
    }

    renderSearch() {
      const strings = getLocaleStrings();

      return platform.react.createElement(
        "div",
        { className: "dccon-search-container" },
        platform.react.createElement(
          "div",
          { className: "dccon-search-bar" },
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
            style: { marginLeft: "8px" },
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
          this.setState({ diagnosticReport: JSON.stringify({ pluginVersion: "4.0.0-beta.2", generatedAt: new Date().toISOString(), ...report }, null, 2),
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
      return platform.react.createElement(
        "div",
        { className: "dccon-saved-container" },
        this.state.savedDccons.length > 0
          ? this.state.savedDccons.map((dccon, index) =>
              platform.react.createElement(SavedDCConCard, {
                key: dccon.info.package_idx,
                dccon: dccon,
                isFirst: index === 0,
                isLast: index === this.state.savedDccons.length - 1,
                onMove: direction => {
                  const reordered = packs.movePack(dccon.info.package_idx, direction);
                  if (reordered) this.setState({savedDccons: reordered});
                },
                onRemove: () => {
                  this.setState({ savedDccons: loadPacks() });
                },
              })
            )
          : platform.react.createElement(
              "div",
              { className: "dccon-empty-state" },
              "추가된 디시콘이 없습니다. '디시콘샵' 탭에서 디시콘을 추가해보세요."
            )
      );
    }

    render() {
      const h = platform.react.createElement;
      if (this.props.section === "settings") {
        return h("div", {className: "dccon-settings-panel dccon-user-settings"},
          h(EmbeddingEnvironmentPanel), this.renderDiagnostics());
      }
      return h("div", {className: "dccon-settings-panel"},
        h("div", {className: "dccon-tab-menu"},
          ...[["saved", "내 디시콘"], ["shop", "디시콘샵"], ["personal", "개별 콘"]].map(([tab, label]) => h("button", {
            key: tab, type: "button", className: "dccon-tab-item " + (this.state.activeTab === tab ? "active" : ""),
            onClick: () => this.handleTabChange(tab),
          }, label))),
        h("div", {className: "dccon-tab-content"}, this.state.activeTab === "saved" ? this.renderSaved() : this.state.activeTab === "personal" ? h(PersonalConManager) : this.renderSearch()));
    }

  }
  // #endregion

  return {PersonalConManager, DCConCard, SavedDCConCard, EmbeddingEnvironmentPanel, DCConSettingsPanel};
}
export type SettingsUI = ReturnType<typeof createSettingsUI>;
