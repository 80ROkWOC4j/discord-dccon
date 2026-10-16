const {version} = require('../package.json');
const {createUserscriptPlatform} = require('../platform/userscript.ts');
const sharedStorage = require('../scripts/shared-storage.cjs'); // Bundled as text; only its pure merge policy is used.
const source = require('../discord-dccon.plugin.js'); // Bundled as text, shared with BD/shelter.

async function start({page, request, load}) {
  if (document.documentElement.dataset.dcconAttachPoc) return;
  document.documentElement.dataset.dcconAttachPoc = 'starting';
  const adapter = createUserscriptPlatform({page, request, load, storageSource: sharedStorage});
  const exported = {exports: {}};
  new Function('DCConPlatform', 'module', source)(adapter.platform, exported);
  const plugin = new exported.exports({name: 'discord-dccon', version});
  await plugin.start();
  document.documentElement.dataset.dcconAttachPoc = 'started';
  window.addEventListener('pagehide', () => {
    plugin.stop(); adapter.dispose();
    delete document.documentElement.dataset.dcconAttachPoc;
  }, {once: true});
}
module.exports = {start};
