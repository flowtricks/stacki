import type { PreloadBridge } from '../../shared/ipc/preloadApi';
import { request } from '../../../../src/features/project/projectClient';

function command(name: string, payload: unknown) {
  return request('/studio/api/git/' + name, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(typeof payload === 'string' ? { projectPath: payload } : payload),
  });
}
export const gitTransport = {
  gitInfo: (payload: Parameters<PreloadBridge['gitInfo']>[0]) => command('info', payload),
  gitStatus: (payload: Parameters<PreloadBridge['gitStatus']>[0]) => command('status', payload),
  gitCommit: (payload: Parameters<PreloadBridge['gitCommit']>[0]) => command('commit', payload),
  gitCheckout: (payload: Parameters<PreloadBridge['gitCheckout']>[0]) => command('checkout', payload),
  gitInit: (payload: Parameters<PreloadBridge['gitInit']>[0]) => command('init', payload),
  gitPush: (payload: Parameters<PreloadBridge['gitPush']>[0]) => command('push', payload),
  gitIncoming: (payload: Parameters<PreloadBridge['gitIncoming']>[0]) => command('incoming', payload),
  gitPull: (payload: Parameters<PreloadBridge['gitPull']>[0]) => command('pull', payload),
  gitResolveMerge: (payload: Parameters<PreloadBridge['gitResolveMerge']>[0]) => command('resolveMerge', payload),
  gitMerge: (payload: Parameters<PreloadBridge['gitMerge']>[0]) => command('merge', payload),
  gitDeleteBranch: (payload: Parameters<PreloadBridge['gitDeleteBranch']>[0]) => command('deleteBranch', payload),
  gitPark: (payload: Parameters<PreloadBridge['gitPark']>[0]) => command('park', payload),
  gitUnpark: (payload: Parameters<PreloadBridge['gitUnpark']>[0]) => command('unpark', payload),
  gitPublish: (payload: Parameters<PreloadBridge['gitPublish']>[0]) => command('publish', payload),
};
