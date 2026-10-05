import { useEffect } from 'react'
import { create } from 'zustand'

type NetworkState = {
  online: boolean
  manualOffline: boolean
  effectiveOnline: boolean
  setManualOffline: (offline: boolean) => void
  refresh: () => void
}

export const useNetworkStore = create<NetworkState>((set, get) => ({
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  manualOffline: false,
  effectiveOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  setManualOffline: (manualOffline) => set({ manualOffline, effectiveOnline: !manualOffline && get().online }),
  refresh: () => {
    const { manualOffline } = get()
    set({ online: navigator.onLine, effectiveOnline: !manualOffline && navigator.onLine })
  },
}))

/** 订阅浏览器 online/offline 事件，返回有效在线状态（物理在线且未手动断网） */
export function useNetwork() {
  const online = useNetworkStore((state) => state.online)
  const manualOffline = useNetworkStore((state) => state.manualOffline)
  const effectiveOnline = useNetworkStore((state) => state.effectiveOnline)
  const setManualOffline = useNetworkStore((state) => state.setManualOffline)

  useEffect(() => {
    const refresh = () => useNetworkStore.getState().refresh()
    window.addEventListener('online', refresh)
    window.addEventListener('offline', refresh)
    return () => {
      window.removeEventListener('online', refresh)
      window.removeEventListener('offline', refresh)
    }
  }, [])

  return { online, manualOffline, effectiveOnline, setManualOffline }
}
