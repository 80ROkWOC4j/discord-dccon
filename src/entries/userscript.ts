import styles from '../core/style.css';
import {createPlugin} from '../core/plugin.ts';
import {createUserscriptPlatform} from '../platform/userscript.ts';
import {version} from '../../package.json';


declare const unsafeWindow: Window & typeof globalThis;
declare const GM_xmlhttpRequest: Parameters<typeof createUserscriptPlatform>[0]['request'];
declare const GM_getValue: Parameters<typeof createUserscriptPlatform>[0]['load'];
export async function start({page, request, load}: Parameters<typeof createUserscriptPlatform>[0]) {
  if (document.documentElement.dataset.dcconAttachPoc) return;
  document.documentElement.dataset.dcconAttachPoc = 'starting';
  const adapter = createUserscriptPlatform({page, request, load});
  const Plugin = createPlugin(adapter.platform, {splitWorkerSource: __DCCON_SPLIT_WORKER__, styles});
  const plugin = new Plugin({name: 'discord-dccon', version});
  await plugin.start();
  document.documentElement.dataset.dcconAttachPoc = 'started';
  window.addEventListener('pagehide', () => {
    plugin.stop(); adapter.dispose();
    delete document.documentElement.dataset.dcconAttachPoc;
  }, {once: true});
}
const boot = () => start({page: unsafeWindow, request: GM_xmlhttpRequest, load: GM_getValue});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, {once: true});
else void boot();
