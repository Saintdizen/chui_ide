import { contextBridge, ipcRenderer } from 'electron';
import {
  PUSH_CHANNEL,
  RPC_CALL_CHANNEL,
  RPC_CANCEL_CHANNEL,
  RPC_EVENT_CHANNEL,
  type PushMessage,
  type RpcCall,
  type RpcEventMessage,
  type RpcResult,
} from '../shared/api';
import { BRIDGE_KEY, type ChuiBridge } from '../shared/bridge';

/**
 * Мост main ↔ renderer. Renderer не получает ни require, ни ipcRenderer:
 * наружу отдаётся только этот объект с четырьмя методами.
 */

type RpcEventListener = (message: RpcEventMessage) => void;
type PushEventListener = (message: PushMessage) => void;

let listenerSeq = 0;
const rpcListeners = new Map<number, RpcEventListener>();
const pushListeners = new Map<number, PushEventListener>();

ipcRenderer.on(RPC_EVENT_CHANNEL, (_event, message: RpcEventMessage) => {
  for (const listener of [...rpcListeners.values()]) listener(message);
});

ipcRenderer.on(PUSH_CHANNEL, (_event, message: PushMessage) => {
  for (const listener of [...pushListeners.values()]) listener(message);
});

const bridge: ChuiBridge = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  call(call: RpcCall): Promise<RpcResult> {
    return ipcRenderer.invoke(RPC_CALL_CHANNEL, call) as Promise<RpcResult>;
  },
  cancel(id: string): Promise<boolean> {
    return ipcRenderer.invoke(RPC_CANCEL_CHANNEL, id) as Promise<boolean>;
  },
  onRpcEvent(listener: RpcEventListener): number {
    listenerSeq += 1;
    rpcListeners.set(listenerSeq, listener);
    return listenerSeq;
  },
  onPush(listener: PushEventListener): number {
    listenerSeq += 1;
    pushListeners.set(listenerSeq, listener);
    return listenerSeq;
  },
  off(listenerId: number): void {
    rpcListeners.delete(listenerId);
    pushListeners.delete(listenerId);
  },
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);
