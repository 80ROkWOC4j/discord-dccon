import type {DiscordExport, DiscordServices, ModuleLookup} from './types.ts';

export function createDiscordServices(modules: ModuleLookup, fiber: (editor: Element) => DiscordExport): DiscordServices {
  const uploadModule = () => modules.getModule(value => typeof value === 'function' &&
    typeof value.prototype?.trackUploadFinished === 'function' && typeof value.prototype?.upload === 'function', {searchExports: true});
  const restModule = () => modules.getModule(value => value !== null && typeof value === 'object' &&
    ['get', 'post', 'put', 'del'].every(key => typeof value[key] === 'function'), {searchExports: true});
  return {
    locale: modules.getByKeys('locale', 'initialize'),
    classes: {icon: modules.getByKeys('icon', 'active', 'buttonWrapper') ?? {},
      textarea: modules.getByKeys('channelTextArea', 'buttonContainer', 'button') ?? {}},
    selectedChannelStore: () => modules.getStore?.('SelectedChannelStore'),
    channelFor(editor) {
      for (let current = fiber(editor); current; current = current.return) {
        const channel = current.memoizedProps?.channel;
        if (channel?.id) return channel.id;
      }
      return modules.getStore?.('SelectedChannelStore')?.getChannelId?.();
    },
    uploadModule, restModule,
    inspect() {
      const report: Record<string, boolean | string> = {};
      const check = (name: string, inspect: () => unknown) => {
        try {report[name] = Boolean(inspect());}
        catch (error) {report[name] = `Lookup failed: ${(error as Error).message}`;}
      };
      check('CloudUpload', uploadModule);
      check('REST post/get/put/del', restModule);
      check('MessageActions.sendMessage', () => modules.getByKeys('sendMessage'));
      for (const name of ['DraftStore', 'UploadAttachmentStore', 'PendingReplyStore', 'SelectedChannelStore']) {
        check(name, () => modules.getStore?.(name));
      }
      return report;
    },
  };
}
