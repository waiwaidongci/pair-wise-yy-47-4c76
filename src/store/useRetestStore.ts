import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Issue, OutboxEntry, RetestBatch, RetestPatch } from '../api/types'
import { resolveEntry, syncEntry } from '../api/retestApi'
import { useWorkspaceStore } from './useWorkspaceStore'

type RetestStore = {
  batches: RetestBatch[]
  entries: OutboxEntry[]
  activeBatchId: string | null
  syncing: boolean
  createBatch: () => string
  setActiveBatch: (id: string) => void
  /** 离线记录入本机批次；同一问题的未完成记录去重保留一条 */
  addEntry: (issue: Issue, patch: RetestPatch) => void
  removeEntry: (id: string) => void
  /** 单项同步，返回最终状态 */
  syncOne: (entryId: string) => Promise<'synced' | 'conflict' | 'failed'>
  /** 逐项同步：已同步项不重做，失败后从剩余项恢复 */
  syncAll: () => Promise<{ synced: number; conflicts: number; failed: number }>
  /** 冲突处理：accept=false 采用对方版本，否则按 choices 提交最终结论 */
  resolve: (entryId: string, accept: boolean, choices: Record<string, 'ours' | 'theirs'>) => Promise<void>
}

const genId = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

const batchName = () => `离线复测批次 ${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}`

const networkErrorText = (err: unknown) => {
  const code = (err as { code?: string })?.code
  const message = (err as { message?: string })?.message
  return code === 'ERR_NETWORK' || message === 'Network Error' ? '网络不可用，待联网后自动重试' : '同步失败，可重试'
}

export const useRetestStore = create<RetestStore>()(
  persist(
    (set, get) => ({
      batches: [],
      entries: [],
      activeBatchId: null,
      syncing: false,

      createBatch: () => {
        const batch: RetestBatch = { id: genId(), name: batchName(), createdAt: new Date().toISOString(), status: 'open' }
        set((state) => ({
          batches: [...state.batches, batch],
          activeBatchId: batch.id,
          entries: state.entries.map((entry) => (entry.batchId === state.activeBatchId ? { ...entry } : entry)),
        }))
        return batch.id
      },

      setActiveBatch: (id) => set({ activeBatchId: id }),

      addEntry: (issue, patch) => {
        let batchId = get().activeBatchId
        if (!batchId || !get().batches.some((batch) => batch.id === batchId && batch.status === 'open')) {
          batchId = get().createBatch()
        }
        set((state) => {
          // 同一问题的未完成（待同步/失败/冲突）记录只保留一条：用最新结论替换
          const existing = state.entries.find(
            (entry) => entry.issueKey === issue.key && ['pending', 'failed', 'conflict'].includes(entry.status),
          )
          const entry: OutboxEntry = {
            id: existing?.id ?? genId(),
            batchId: batchId!,
            issueKey: issue.key,
            issueTitle: issue.title,
            baseIssue: structuredClone(issue),
            patch,
            createdAt: new Date().toISOString(),
            status: 'pending',
          }
          return {
            entries: existing
              ? state.entries.map((item) => (item.id === existing.id ? entry : item))
              : [...state.entries, entry],
          }
        })
      },

      removeEntry: (id) => set((state) => ({ entries: state.entries.filter((entry) => entry.id !== id) })),

      syncOne: async (entryId) => {
        const entry = get().entries.find((item) => item.id === entryId)
        if (!entry) return 'failed'
        set((state) => ({ entries: state.entries.map((item) => (item.id === entryId ? { ...item, status: 'syncing', error: undefined } : item)) }))
        try {
          const result = await syncEntry(entry)
          if (result.status === 'synced') {
            set((state) => ({
              entries: state.entries.map((item) =>
                item.id === entryId ? { ...item, status: 'synced', error: undefined, conflictFields: undefined, serverIssue: undefined } : item,
              ),
            }))
            useWorkspaceStore.getState().updateIssue(result.issue)
            return 'synced'
          }
          set((state) => ({
            entries: state.entries.map((item) =>
              item.id === entryId ? { ...item, status: 'conflict', conflictFields: result.fields, serverIssue: result.issue } : item,
            ),
          }))
          return 'conflict'
        } catch (err) {
          set((state) => ({
            entries: state.entries.map((item) => (item.id === entryId ? { ...item, status: 'failed', error: networkErrorText(err) } : item)),
          }))
          return 'failed'
        }
      },

      syncAll: async () => {
        set({ syncing: true })
        let synced = 0
        let conflicts = 0
        let failed = 0
        const targets = get().entries.filter((entry) => ['pending', 'failed'].includes(entry.status))
        for (const target of targets) {
          const result = await get().syncOne(target.id)
          if (result === 'synced') synced += 1
          else if (result === 'conflict') conflicts += 1
          else {
            failed += 1
            // 网络中断：从剩余项恢复，已同步项不重做
            if (typeof navigator === 'undefined' || !navigator.onLine) break
          }
        }
        set({ syncing: false })
        return { synced, conflicts, failed }
      },

      resolve: async (entryId, accept, choices) => {
        const entry = get().entries.find((item) => item.id === entryId)
        if (!entry) return
        const issue = await resolveEntry(entry, accept, choices)
        set((state) => ({
          entries: state.entries.map((item) =>
            item.id === entryId ? { ...item, status: 'synced', error: undefined, conflictFields: undefined, serverIssue: undefined } : item,
          ),
        }))
        useWorkspaceStore.getState().updateIssue(issue)
      },
    }),
    {
      name: 'accessibility-retest-outbox-v1',
      version: 1,
      partialize: (state) => ({ batches: state.batches, entries: state.entries, activeBatchId: state.activeBatchId }),
    },
  ),
)
