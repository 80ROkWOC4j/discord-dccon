import type {Platform} from '../platform/types.ts';
import type {Con, Pack, PackId, PackSearchResult} from './types.ts';
import type {SettingsService} from './settings.ts';
import type {Images} from './images.ts';
import type {Events} from './events.ts';
export const DCConBaseURL = 'https://dcimg5.dcinside.com/dccon.php?no=';
export const DCConProxyURL = 'https://dccon-proxy.minibox.workers.dev/?no=';
export const PERSONAL_PACK = 'personal-cons';
export function createPacks(platform: Platform, settings: SettingsService, images: Pick<Images, "warmCache">, events: Events) {
  const {loadData, saveData} = settings;
  const getDCCon = (idx: PackId) => {
    return new Promise<Pack>((resolve, reject) => {
      platform.net.fetch("https://dccon.dcinside.com/index/package_detail", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
        },
        body: `package_idx=${idx}`,
      })
        .then((r) => r.text())
        .then((body) => {
          const original = JSON.parse(body) as Pack;

          const info = {
            package_idx: original.info.package_idx,
            title: original.info.title,
            main_img_path: original.info.main_img_path,
            list_img_path: original.info.list_img_path,
          };

          const detail = original.detail.map((x: Con) => {
            return { idx: x.idx, title: x.title, ext: x.ext, path: x.path };
          });

          resolve({ info, detail });
        })
        .catch((err) => {
          reject(err);
        });
    });
  };
  function personalCons() { return loadData("personalCons", []); }
  function pickerPacks() {
    const packs = loadPacks(), detail = personalCons();
    return detail.length ? [{info: {package_idx: PERSONAL_PACK, title: "개별 콘"}, detail}, ...packs] : packs;
  }
  function uniquePacks(packs: Pack[]) {
    const seen = new Set();
    return packs.filter(pack => {
      const id = String(pack.info.package_idx);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function loadPacks() {
    return uniquePacks(loadData("dccons", []));
  }

  // 디시콘 검색 결과를 가져오는 함수
  const getDCConSearchResult = (query: string) => {
    return new Promise<PackSearchResult[]>((resolve, reject) => {
      platform.net.fetch(
        encodeURI("https://dccon.dcinside.com/hot/1/title/" + query)
      )
        .then((r) => r.text())
        .then((body) => {
          const parser = new DOMParser();
          const doc = parser.parseFromString(body, "text/html");

          if (doc.getElementsByClassName("dccon_search_none").length > 0) {
            resolve([]);
            return;
          }

          const results = [...doc.getElementsByClassName("link_product")].map(
            (el) => {
              const idx = (el as HTMLAnchorElement).href.split("#")[1];
              const thumbId = (el.children[0] as HTMLImageElement).src.split("=")[1];
              const name = (el.children[1] as HTMLElement).innerText;
              const seller = (el.children[2] as HTMLElement).innerText;

              return { idx, thumbId, name, seller };
            }
          );

          resolve(results);
        })
        .catch((err) => reject(err));
    });
  };

  function initialize() {
    if (loadData('dccons') === undefined) saveData('dccons', []);
    const saved = loadData('dccons', []), repaired = uniquePacks(saved);
    if (saved.length !== repaired.length) {
      if (loadData('dcconsBeforeDedup') === undefined) saveData('dcconsBeforeDedup', saved);
      saveData('dccons', repaired);
    }
    if (loadData('recent') === undefined) saveData('recent', []);
    return repaired;
  }
  async function addPack(id: PackId) {
    const pack = await getDCCon(id);
    // Re-read after the request so concurrent additions cannot duplicate a pack.
    saveData('dccons', uniquePacks([...loadPacks(), pack]));
    images.warmCache(pack.detail);
    return pack;
  }
  function removePack(id: PackId) {
    saveData('dccons', loadPacks().filter(pack => String(pack.info.package_idx) !== String(id)));
  }
  function movePack(id: PackId, direction: number) {
    const packs = loadPacks(), from = packs.findIndex(pack => String(pack.info.package_idx) === String(id));
    const to = from + direction;
    if (from < 0 || to < 0 || to >= packs.length) return;
    [packs[from], packs[to]] = [packs[to], packs[from]];
    saveData('dccons', packs);
    return packs;
  }
  function setExpanded(id: PackId, expanded: boolean) {
    const collapsed = loadData('collapsedPacks', {});
    if (expanded) delete collapsed[String(id)]; else collapsed[String(id)] = true;
    saveData('collapsedPacks', collapsed);
  }
  function toggleFavorite(con: Con) {
    const favorites = loadData('favorites', []);
    saveData('favorites', favorites.some(item => item.path === con.path)
      ? favorites.filter(item => item.path !== con.path) : [...favorites, con]);
    events.dispatch({type: 'DCCON_FAVORITES_UPDATE'});
  }
  return {getDCCon, getDCConSearchResult, personalCons, pickerPacks, uniquePacks, loadPacks, initialize, addPack, removePack, movePack, setExpanded, toggleFavorite};
}
export type Packs = ReturnType<typeof createPacks>;
