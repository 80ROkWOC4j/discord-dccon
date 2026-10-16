const fs = require('node:fs/promises');
const path = require('node:path');
const {version} = require('../package.json');
const root = path.resolve(__dirname, '..');
async function main() {
  const source = require('./build.cjs').buildEntry('userscript');
  const metadata = `// ==UserScript==
// @name discord-dccon Attach PoC
// @namespace https://github.com/80ROkWOC4j/discord-dccon
// @version ${version}
// @description 디시콘을 검색해 Discord 입력창에 첨부합니다. 전송은 직접 하세요.
// @match https://discord.com/*
// @match https://ptb.discord.com/*
// @match https://canary.discord.com/*
// @run-at document-end
// @inject-into page
// @noframes
// @grant GM_xmlhttpRequest
// @grant GM_getValue
// @grant unsafeWindow
// @connect dcinside.com
// @connect ac.arca.live
// @connect cdn.jsdelivr.net
// @connect api.github.com
// @connect huggingface.co
// @connect hf.co
// @connect xethub.hf.co
// ==/UserScript==
`;
  const output = path.join(root, 'artifacts/userscript/discord-dccon.user.js');
  await fs.mkdir(path.dirname(output), {recursive: true});
  const reactLicense = await fs.readFile(path.join(root, 'node_modules/react/LICENSE'), 'utf8');
  const hashLicense = await fs.readFile(path.join(root, 'node_modules/@noble/hashes/LICENSE'), 'utf8');
  await fs.writeFile(output, metadata + `/* React / ReactDOM / Scheduler license:\n${reactLicense}\n\n@noble/hashes license:\n${hashLicense}\n*/\n` + source);
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md'])
    await fs.copyFile(path.join(root, file), path.join(path.dirname(output), file));
  await fs.copyFile(path.join(root, 'node_modules/@noble/hashes/LICENSE'), path.join(path.dirname(output), 'noble-hashes-LICENSE.txt'));
  console.log(output);
}
main().catch(error => {console.error(error); process.exitCode = 1;});
