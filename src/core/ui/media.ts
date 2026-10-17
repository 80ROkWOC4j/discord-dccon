import type {Platform} from '../../platform/types.ts';
import type {ImageProps, BufferImageProps, PersonalImageProps, ThumbnailProps, ButtonProps} from '../ui-types.ts';
import type {Images} from '../images.ts';
import {DCConProxyURL, PERSONAL_PACK} from '../packs.ts';
export function createMediaUI(platform: Platform, images: Pick<Images, "getDCConImage">) {
  const classes = platform.discord.classes;
  class DCConImage extends platform.react.Component<ImageProps, {source?: string}> {
    declare observer?: IntersectionObserver;
    declare controller?: AbortController;
    declare url?: string;
    declare image: HTMLImageElement;

    constructor(props: ImageProps) { super(props); this.state = {source: undefined}; }
    componentDidMount() { this.load(); }
    componentDidUpdate(previous: ImageProps) { if (previous.src !== this.props.src) this.load(); }
    componentWillUnmount() { this.release(); }
    release() {
      this.observer?.disconnect();
      this.observer = undefined;
      this.controller?.abort();
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = undefined;
    }
    load() {
      if (!platform.net?.resolveImage) return;
      this.release();
      this.setState({source: undefined});
      const download = () => {
        const controller = this.controller = new AbortController();
        platform.net.resolveImage!(this.props.src, controller.signal).then(blob => {
          if (controller.signal.aborted) return;
          this.url = URL.createObjectURL(blob);
          this.setState({source: this.url});
        }).catch(() => {if (!controller.signal.aborted) this.props.onError?.();});
      };
      if (typeof IntersectionObserver === "undefined") { download(); return; }
      const observer = this.observer = new IntersectionObserver(entries => {
        if (this.observer !== observer || !entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect(); this.observer = undefined;
        download();
      }, {root: this.image.closest(".dccon-browser-content, .dccon-popover-body, .dccon-rail"), rootMargin: "160px"});
      observer.observe(this.image);
    }
    render() {
      return platform.react.createElement("img", {...this.props,
        ref: image => { this.image = image as HTMLImageElement; },
        src: platform.net?.resolveImage ? this.state.source : this.props.src,
        loading: platform.net?.resolveImage ? "eager" : this.props.loading,
      });
    }
  }

  const ManduIcon = (props: {size?: string}) => {
    const size = props.size || "24px";

    return platform.react.createElement(
      "svg",
      {
        viewBox: "0 0 512 512",
        className: classes.icon.icon,
        "aria-hidden": "false",
        width: size,
        height: size,
      },
      platform.react.createElement("path", {
        transform: "translate(0,512) scale(0.1,-0.1)",
        fill: "currentColor",
        d: "M2490 4778 c-142 -20 -270 -116 -332 -248 -30 -65 -35 -70 -58 -65 -60 14 -195 17 -249 5 -179 -39 -278 -147 -360 -391 -26 -79 -30 -85 -72 -108 -341 -182 -501 -295 -723 -511 -340 -331 -569 -722 -654 -1120 -91 -420 -29 -784 190 -1112 74 -111 257 -298 373 -380 480 -339 1130 -509 1955 -509 733 0 1322 133 1785 401 148 86 244 159 365 280 169 167 278 341 344 545 119 368 71 803 -133 1220 -126 255 -278 462 -497 675 -222 216 -383 329 -723 511 -44 23 -45 26 -82 137 -21 63 -50 134 -65 159 -53 91 -150 164 -263 199 -56 18 -182 19 -245 3 -26 -6 -48 -10 -49 -8 -2 2 -18 35 -36 72 -61 126 -192 226 -316 242 -27 3 -59 7 -70 9 -11 2 -49 -1 -85 -6z m-470 -1163 c62 -32 92 -105 72 -174 -17 -55 -364 -396 -409 -403 -111 -16 -198 72 -178 179 6 32 32 64 173 207 92 92 181 177 197 187 36 23 105 25 145 4z m621 -8 c64 -42 70 -68 67 -284 -3 -177 -5 -194 -24 -220 -47 -63 -132 -84 -195 -47 -70 41 -74 54 -77 267 -2 168 0 196 15 227 26 50 76 80 133 80 32 0 58 -7 81 -23z m597 9 c15 -8 104 -92 199 -188 187 -189 198 -207 174 -288 -13 -45 -69 -96 -112 -102 -74 -11 -86 -4 -276 185 -192 189 -211 216 -200 284 8 46 30 79 70 103 38 24 106 26 145 6z",
      })
    );
  };
  class BufferImage extends platform.react.Component<BufferImageProps, {url: string | null}> {

    constructor(props: BufferImageProps) { super(props); this.state = {url: null}; }
    componentDidMount() { this.setState({url: URL.createObjectURL(this.props.file)}); }
    componentDidUpdate(previous: BufferImageProps) {
      if (previous.file !== this.props.file) {
        URL.revokeObjectURL(this.state.url!);
        this.setState({url: URL.createObjectURL(this.props.file)});
      }
    }
    componentWillUnmount() { if (this.state.url) URL.revokeObjectURL(this.state.url!); }
    render() { return this.state.url && platform.react.createElement("img", {src: this.state.url, alt: this.props.title, className: this.props.className}); }
  }

  class PersonalImage extends platform.react.Component<PersonalImageProps, {file: File | null}> {
    declare disposed: boolean;

    constructor(props: PersonalImageProps) { super(props); this.state = {file: null}; }
    componentDidMount() {
      images.getDCConImage(this.props.con).then(file => {
        if (!this.disposed) this.setState({file});
      }).catch(() => { if (!this.disposed) this.props.onError?.(); });
    }
    componentWillUnmount() { this.disposed = true; }
    render() { return this.state.file && platform.react.createElement(BufferImage, {file: this.state.file, title: this.props.con.title, className: this.props.className}); }
  }
  class PackThumbnail extends platform.react.Component<ThumbnailProps, {index: number}> {

    constructor(props: ThumbnailProps) {
      super(props);
      this.state = { index: 0 };
    }

    render() {
      const { pack, className } = this.props;
      if (pack.info.package_idx === PERSONAL_PACK) {
        const con = pack.detail[0];
        return con ? platform.react.createElement(PersonalImage, {key: con.path, con, className}) : null;
      }
      const paths = [...new Set([pack.info.main_img_path, pack.detail[0]?.path, pack.info.list_img_path].filter(Boolean))];
      if (!paths[this.state.index]) {
        return platform.react.createElement("span", { className, "aria-hidden": true }, pack.info.title.slice(0, 1));
      }
      const next = () => this.setState(state => ({ index: state.index + 1 }));
      return platform.react.createElement(DCConImage, {
        className, alt: "", src: DCConProxyURL + paths[this.state.index], loading: "lazy",
        onError: next,
        onLoad: event => { if (event.currentTarget.naturalWidth <= 1 || event.currentTarget.naturalHeight <= 1) next(); },
      });
    }
  }

  // 카테고리 컴포넌트
  const Button = (props: ButtonProps) => {
    return platform.react.createElement(
      "button",
      {
        type: "button",
        className: `bd-button dccon-button ${props.color || ""}`,
        onClick: props.onClick,
        disabled: props.disabled,
        style: { ...props.style },
      },
      props.text
    );
  };

  return {DCConImage, BufferImage, PersonalImage, PackThumbnail, ManduIcon, Button};
}
export type MediaUI = ReturnType<typeof createMediaUI>;
