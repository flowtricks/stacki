import { projectAliases } from '../properties/importPaths';
import type { MainHost } from './mainHost';
import { convertImage } from '../project/imageConversion';

export function registerImageConversionHandler(host: Pick<MainHost, 'ipcMain' | 'shell' | 'noteAppWrite' | 'send'>): void {
  // Image codecs and multi-file rewrites run one at a time, with no growing queue.
  let running = false;
  host.ipcMain.handle('assets:convert', async (_event, payload) => {
    if (running) {
      throw new Error('Another image is being converted. Try again when it finishes.');
    }
    running = true;
    try {
      const result = await convertImage({
        ...payload,
        aliases: projectAliases(payload.projectPath),
        trash: (file) => host.shell.trashItem(file),
      });
      host.noteAppWrite();
      host.send('assets:changed', {});
      if (!result.ok) {
        throw new Error(result.error);
      }
      return result.value;
    } finally {
      running = false;
    }
  });
}
