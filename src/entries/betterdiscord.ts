import styles from '../core/style.css';
import {createPlugin} from '../core/plugin.ts';
import {createBetterDiscordPlatform} from '../platform/betterdiscord.ts';

declare const BdApi: Parameters<typeof createBetterDiscordPlatform>[0];
export default createPlugin(createBetterDiscordPlatform(BdApi, require), {splitWorkerSource: __DCCON_SPLIT_WORKER__, styles});
