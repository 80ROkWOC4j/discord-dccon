import type {Platform} from '../../platform/types.ts';
import type * as React from 'react';
import type {PluginEvent} from '../types.ts';
import type {ChannelProps} from '../ui-types.ts';
import type {Events} from '../events.ts';
import type {Sending} from '../sending.ts';
import type {MediaUI} from './media.ts';
import type {PickerUI} from './picker.ts';
import type {SettingsUI} from './settings.ts';
export function mountToolbar(platform: Platform, Button: React.ComponentType<ChannelProps>) {
  const roots = new Map<Element, {host: HTMLDivElement; root: ReturnType<Platform["reactDOM"]["createRoot"]>; channelId?: string}>();
  const store = platform.discord.selectedChannelStore();
  let pending = false, stopped = false;
  function channelFor(editor: Element) {
    if (platform.composer?.targetFor) return platform.composer.targetFor(editor);
    return platform.discord.channelFor(editor);
  }
  function update() {
    pending = false;
    if (stopped) return;
    const active = new Set();
    for (const editor of document.querySelectorAll('[role="textbox"][contenteditable="true"], [class*="channelTextArea"] textarea')) {
      const composer = editor.closest('[class*="channelTextArea"]');
      const toolbar = composer?.querySelector('[class*="buttons_"]');
      const channelId = channelFor(editor);
      if (!toolbar || !channelId) continue;
      active.add(toolbar);
      let entry = roots.get(toolbar);
      if (entry && !toolbar.contains(entry.host)) {
        entry.root.unmount(); roots.delete(toolbar); entry = undefined;
      }
      if (!entry) {
        const host = document.createElement("div");
        host.className = "dccon-toolbar-host";
        host.style.cssText = "display:flex;align-items:center;flex:0 0 auto";
        toolbar.append(host);
        entry = {host, root: platform.reactDOM.createRoot(host)};
        roots.set(toolbar, entry);
      }
      if (entry.channelId !== channelId) {
        entry.channelId = channelId;
        entry.root.render(platform.react.createElement(Button, {channelId}));
      }
    }
    for (const [toolbar, entry] of roots) if (!active.has(toolbar)) {
      entry.root.unmount(); entry.host.remove(); roots.delete(toolbar);
    }
  }
  function schedule() {
    if (pending || stopped) return;
    pending = true;
    queueMicrotask(update);
  }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {childList: true, subtree: true});
  store?.addChangeListener!(schedule);
  update();
  return () => {
    stopped = true; observer.disconnect(); store?.removeChangeListener!(schedule);
    for (const entry of roots.values()) {entry.root.unmount(); entry.host.remove();}
    roots.clear();
  };
}

export function createToolbarUI(platform: Platform, sending: Pick<Sending, "activeQueue" | "setCurrentChannel">, PluginEvents: Events, media: MediaUI, picker: PickerUI, settings: SettingsUI) {
  const classes = platform.discord.classes;
  const {activeQueue} = sending;
  const {ManduIcon} = media;
  const {BufferTray, DCConPanel} = picker;
  const {DCConSettingsPanel} = settings;
  class DCConButton extends platform.react.Component<ChannelProps, {active: boolean; page: string}> {
    declare button: HTMLButtonElement | null;
    declare refreshBuffer: () => void;
    declare onKeyDown: (event: KeyboardEvent) => void;

    constructor(props: ChannelProps) {
      super(props);
      this.state = { active: false, page: "picker" };
      this.close = this.close.bind(this);
      this.refreshBuffer = () => { if (this.state.active) this.forceUpdate(); };
      this.onKeyDown = (event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          this.close();
          this.button?.focus();
        }
      };
    }

    componentDidMount() {
      PluginEvents.subscribe("DCCON_CLOSE", this.close);
      PluginEvents.subscribe("DCCON_UNPATCH_ALL", this.close);
      PluginEvents.subscribe("DCCON_BUFFER_UPDATE", this.refreshBuffer);
      window.addEventListener("resize", this.refreshBuffer);
      window.visualViewport?.addEventListener("resize", this.refreshBuffer);
      window.visualViewport?.addEventListener("scroll", this.refreshBuffer);
      document.addEventListener("keydown", this.onKeyDown, true);
    }

    componentDidUpdate(previousProps: ChannelProps) {
      if (previousProps.channelId !== this.props.channelId) this.close();
    }

    componentWillUnmount() {
      PluginEvents.unsubscribe("DCCON_CLOSE", this.close);
      PluginEvents.unsubscribe("DCCON_UNPATCH_ALL", this.close);
      PluginEvents.unsubscribe("DCCON_BUFFER_UPDATE", this.refreshBuffer);
      window.removeEventListener("resize", this.refreshBuffer);
      window.visualViewport?.removeEventListener("resize", this.refreshBuffer);
      window.visualViewport?.removeEventListener("scroll", this.refreshBuffer);
      document.removeEventListener("keydown", this.onKeyDown, true);
    }

    close(event?: PluginEvent | React.MouseEvent) {
      if (event && "channelId" in event && event.channelId && event.channelId !== this.props.channelId) return;
      if (this.state.active) this.setState({ active: false });
    }

    toggle() {
      if (this.state.active) return this.close();
      PluginEvents.dispatch({ type: "DCCON_CLOSE" });
      sending.setCurrentChannel(this.props.channelId);
      this.setState({
        active: true,
        page: "picker",
      });
    }

    render() {
      const h = platform.react.createElement;
      const expanded = this.state.page === "picker" && activeQueue(this.props.channelId).length > 0;
      const viewport = window.visualViewport;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const x = viewport?.offsetLeft ?? 0, y = viewport?.offsetTop ?? 0;
      const compact = viewportWidth < 600;
      const width = compact ? viewportWidth - 16 : Math.min(expanded ? 780 : 520, viewportWidth - 16);
      const height = Math.min(compact ? 620 : 540, viewportHeight - 16);
      const rect = this.button?.getBoundingClientRect();
      const left = Math.max(x + 8, Math.min((rect?.right ?? x + width) - width, x + viewportWidth - width - 8));
      const top = Math.max(y + 8, Math.min((rect?.top ?? y + height) - height - 8, y + viewportHeight - height - 8));
      return h("div", { className: (classes.textarea.buttonContainer ?? "") + " dccon-buttonContainer" },
        h("button", {
          type: "button",
          className: "dccon-button dccon-trigger",
          "aria-label": "디시콘",
          "aria-haspopup": "dialog",
          "aria-expanded": this.state.active,
          ref: (button) => { this.button = button as HTMLButtonElement | null; },
          onPointerDown: (event) => { event.preventDefault(); event.stopPropagation(); },
          onClick: (event) => { event.stopPropagation(); this.toggle(); },
        }, h(ManduIcon)),
        this.state.active && platform.reactDOM.createPortal(
          h("div", { className: "dccon-overlay", onMouseDown: this.close },
            h("section", {
              className: "dccon-popover" + (expanded ? " dccon-popover-expanded" : "") +
                (compact ? " dccon-popover-compact" : "") + (compact && viewportHeight < 480 ? " dccon-popover-short" : ""),
              role: "dialog",
              "aria-label": "디시콘 선택",
              style: { left, top, height, width, "--dccon-tray-max-height": Math.floor(height * 0.4) + "px" } as React.CSSProperties,
              onMouseDown: (event) => event.stopPropagation(),
            },
              h("div", {className: "dccon-popover-main", key: "main"},
              h("div", { className: "dccon-popover-toolbar" },
                ...[["picker", "내 디시콘"], ["packs", "팩 추가 / 관리"], ["settings", "설정"]].map(([page, label]) =>
                  h("button", { key: page, type: "button", "aria-pressed": this.state.page === page,
                    onClick: () => this.setState({ page }) }, label)),
                h("button", { type: "button", "aria-label": "닫기", onClick: this.close }, "×")
              ),
              h("div", { className: "dccon-popover-body" },
                this.state.page !== "picker" ? h(DCConSettingsPanel, { key: this.state.page, section: this.state.page }) : h(DCConPanel, { type: "dccon", onManage: () => this.setState({ page: "packs" }) })
              )),
              expanded && h(BufferTray, {key: "buffer", channelId: this.props.channelId})
            )
          ), document.body
        )
      );
    }
  }

  return {DCConButton, mountToolbar: (Button: React.ComponentType<ChannelProps>) => mountToolbar(platform, Button)};
}
