import browser from './browser';
import type { RpcMethod, RpcMethods, RpcRequest, RpcResponse } from './messages';

export async function rpc<M extends RpcMethod>(
  method: M,
  ...args: RpcMethods[M]['params'] extends void ? [] : [RpcMethods[M]['params']]
): Promise<RpcMethods[M]['result']> {
  const req: RpcRequest<M> = { type: 'rpc', method, params: args[0] as RpcMethods[M]['params'] };
  const res = (await browser.runtime.sendMessage(req)) as RpcResponse<M> | undefined;
  if (!res) throw new Error('No response from background');
  if (!res.ok) throw new Error(res.error);
  return res.result;
}
