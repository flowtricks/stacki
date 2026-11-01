import type { PreloadBridge } from '../../shared/ipc/preloadApi';

// Desktop invokes preload; Studio supplies the HTTP implementation at assembly.
export const gitTransport = {
  gitInfo: (payload: Parameters<PreloadBridge['gitInfo']>[0]) => window.avb.gitInfo(payload),
  gitStatus: (payload: Parameters<PreloadBridge['gitStatus']>[0]) => window.avb.gitStatus(payload),
  gitCommit: (payload: Parameters<PreloadBridge['gitCommit']>[0]) => window.avb.gitCommit(payload),
  gitCheckout: (payload: Parameters<PreloadBridge['gitCheckout']>[0]) => window.avb.gitCheckout(payload),
  gitInit: (payload: Parameters<PreloadBridge['gitInit']>[0]) => window.avb.gitInit(payload),
  gitPush: (payload: Parameters<PreloadBridge['gitPush']>[0]) => window.avb.gitPush(payload),
  gitIncoming: (payload: Parameters<PreloadBridge['gitIncoming']>[0]) => window.avb.gitIncoming(payload),
  gitPull: (payload: Parameters<PreloadBridge['gitPull']>[0]) => window.avb.gitPull(payload),
  gitResolveMerge: (payload: Parameters<PreloadBridge['gitResolveMerge']>[0]) => window.avb.gitResolveMerge(payload),
  gitMerge: (payload: Parameters<PreloadBridge['gitMerge']>[0]) => window.avb.gitMerge(payload),
  gitDeleteBranch: (payload: Parameters<PreloadBridge['gitDeleteBranch']>[0]) => window.avb.gitDeleteBranch(payload),
  gitPark: (payload: Parameters<PreloadBridge['gitPark']>[0]) => window.avb.gitPark(payload),
  gitUnpark: (payload: Parameters<PreloadBridge['gitUnpark']>[0]) => window.avb.gitUnpark(payload),
  gitPublish: (payload: Parameters<PreloadBridge['gitPublish']>[0]) => window.avb.gitPublish(payload),
};
