/**
 * 网络可用性：真实浏览器网络状态 × 手动"会议室断网"模拟开关。
 * 复测员带电脑进会议室网络不稳，可用开关模拟断网/恢复，数据照常留在本机。
 */
const STORAGE_KEY = 'offline-retest:simulated-offline'

type Listener = (online: boolean) => void
const listeners = new Set<Listener>()

function simulatedOffline(): boolean {
  return localStorage.getItem(STORAGE_KEY) === '1'
}

export function isOnline(): boolean {
  return navigator.onLine && !simulatedOffline()
}

export function setSimulatedOffline(offline: boolean) {
  localStorage.setItem(STORAGE_KEY, offline ? '1' : '0')
  emit()
}

export function isSimulatedOffline(): boolean {
  return simulatedOffline()
}

function emit() {
  const online = isOnline()
  listeners.forEach((listener) => listener(online))
}

export function subscribeNetwork(listener: Listener): () => void {
  listeners.add(listener)
  window.addEventListener('online', emit)
  window.addEventListener('offline', emit)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('online', emit)
    window.removeEventListener('offline', emit)
  }
}
