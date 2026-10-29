// DEBUG BUILDS ONLY (`node build.mjs --debug-bridge`). Never shipped in normal builds.
// Lets automation on a reddit.com tab drive the background RPC and storage, because
// browser automation can't script moz-extension:// pages.
import browser from '../shared/browser';

addEventListener('message', (e: MessageEvent) => {
  const data = e.data as { rhDebug?: string; id?: number; params?: unknown } | null;
  if (e.source !== window || !data?.rhDebug) return;
  const reply = (payload: unknown) => window.postMessage({ rhDebugReply: data.id, payload }, '*');
  const run = async () => {
    switch (data.rhDebug) {
      case 'storageGet':
        return browser.storage.local.get(data.params as string[] | null);
      case 'storageSet':
        return browser.storage.local.set(data.params as Record<string, unknown>);
      default:
        return browser.runtime.sendMessage({
          type: 'rpc',
          method: data.rhDebug,
          params: data.params,
          debugBridge: true,
        });
    }
  };
  run().then(reply, (err: unknown) => reply({ bridgeError: String(err) }));
});
