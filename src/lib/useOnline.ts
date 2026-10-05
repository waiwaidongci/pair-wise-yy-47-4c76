import { useSyncExternalStore } from 'react'
import { isOnline, subscribeNetwork } from './network'

/** 响应式网络状态：真实网络 × 断网模拟开关 */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribeNetwork, isOnline, isOnline)
}
