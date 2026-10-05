import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  EntrySyncState,
  Issue,
  OfflineBatch,
  OfflineEntry,
  PatchFields,
  RetestField,
  RetestResult,
  ServerIssue,
  WatchedField,
} from '../api/types'
import { ConflictError, OfflineError, patchIssue } from '../api/client'
import { seedIssues } from '../api/seed'
import { formatAt } from '../lib/time'

type SavedFilter = { id: string; name: string; query: string; site: string; status: string; priority: string }

export type EntryDraft = {
  result: RetestResult
  environment: string
  evidence: string
  note: string
  changedFields: RetestField[]
}

const stripRevision = (issue: ServerIssue): Issue => {
  const { revision: _revision, ...rest } = issue
  return rest
}

const ENTRY_STATES_TO_SYNC: EntrySyncState[] = ['待提交', '同步失败']

type WorkspaceState = {
  /** 服务器最新视图（只在拉取 / 同步成功时更新），冲突比对的"远端版本"来源 */
  serverIssues: ServerIssue[]
  /** 上一个确认版本：无活动批次时跟随服务器；有批次/冲突期间冻结，逐项确认后更新 */
  issues: Issue[]
  confirmedAt: string
  lastSyncAt?: string
  batch: OfflineBatch | null

  selectedKeys: string[]
  savedFilters: SavedFilter[]
  draft: string
  mergeKeys: string[]

  hydrateFromServer: (issues: ServerIssue[]) => void
  replaceServerIssue: (issue: ServerIssue) => void
  startBatch: (input: { name: string; room: string; device: string; actor: string; keys: string[] }) => void
  saveEntry: (issueKey: string, draft: EntryDraft) => void
  removeEntry: (issueKey: string) => void
  abortBatch: () => void
  archiveBatch: () => void
  syncBatch: () => Promise<{ autoMerged: string[]; deduped: string[] }>
  resolveConflict: (issueKey: string, take: Partial<Record<RetestField, 'local' | 'remote'>>) => Promise<void>

  setIssues: (issues: Issue[]) => void
  setSelectedKeys: (keys: string[]) => void
  saveFilter: (filter: Omit<SavedFilter, 'id'>) => void
  removeFilter: (id: string) => void
  setDraft: (draft: string) => void
  mergeIssues: (keys: string[]) => void
  updateIssue: (issue: Issue) => void
}

let syncing = false

/** 与确认基线比较，只标记本人真正改过的字段 */
export function diffChangedFields(
  values: { result: RetestResult; environment: string; evidence: string; note: string },
  base: Issue,
): RetestField[] {
  const changed: RetestField[] = []
  if (values.result !== base.status) changed.push('status')
  if (values.environment.trim() !== (base.retestEnv ?? '').trim()) changed.push('retestEnv')
  if (values.evidence.trim() !== (base.retestEvidence ?? '').trim()) changed.push('retestEvidence')
  if (values.note.trim() !== (base.retestRecords.at(-1)?.note ?? '').trim()) changed.push('retestNote')
  return changed
}

/** 按本人改过的字段构造只含本人字段的 PATCH 载荷 */
function buildFields(entry: Pick<OfflineEntry, 'result' | 'environment' | 'evidence' | 'note' | 'changedFields'>): PatchFields {
  const fields: PatchFields = {}
  if (entry.changedFields.includes('status')) fields.status = entry.result
  if (entry.changedFields.includes('retestEnv')) fields.retestEnv = entry.environment
  if (entry.changedFields.includes('retestEvidence')) fields.retestEvidence = entry.evidence
  if (entry.changedFields.includes('retestNote')) fields.retestNote = entry.note
  return fields
}

/** 只要本轮有本人改过的字段就留复测痕；记录内容只随改过的字段落库 */
function buildPayload(batch: OfflineBatch, entry: OfflineEntry, fields: PatchFields) {
  return {
    base: batch.baseRevisions[entry.issueKey],
    fields,
    record:
      Object.keys(fields).length > 0
        ? {
            id: entry.recordId,
            actor: batch.actor,
            result: entry.result,
            note: entry.note || '（详见备注）',
            environment: entry.environment,
            evidence: entry.evidence,
          }
        : null,
  }
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      serverIssues: structuredClone(seedIssues),
      issues: seedIssues.map(stripRevision),
      confirmedAt: formatAt(),
      lastSyncAt: undefined,
      batch: null,

      selectedKeys: [],
      savedFilters: [
        { id: 'f1', name: 'P0/P1 未关闭', query: '', site: '', status: '', priority: 'P0' },
        { id: 'f2', name: '基础组件组待复测', query: '基础组件', site: '', status: '待复测', priority: '' },
      ],
      draft: '',
      mergeKeys: [],

      /** 服务器数据到达：无活动批次时刷新"上一个确认版本"；有批次时只更新远端视图，确认视图保持冻结 */
      hydrateFromServer: (incoming) =>
        set((state) => {
          const serverIssues = structuredClone(incoming)
          if (state.batch) return { serverIssues, lastSyncAt: formatAt() }
          return { serverIssues, issues: serverIssues.map(stripRevision), confirmedAt: formatAt(), lastSyncAt: formatAt() }
        }),

      replaceServerIssue: (issue) =>
        set((state) => ({ serverIssues: state.serverIssues.map((item) => (item.key === issue.key ? structuredClone(issue) : item)) })),

      startBatch: ({ name, room, device, actor, keys }) =>
        set((state) => {
          if (state.batch) return state
          const baseSnapshot: OfflineBatch['baseSnapshot'] = {}
          const baseRevisions: OfflineBatch['baseRevisions'] = {}
          keys.forEach((key) => {
            const confirmed = state.issues.find((item) => item.key === key)
            const server = state.serverIssues.find((item) => item.key === key)
            if (confirmed) baseSnapshot[key] = structuredClone(confirmed)
            if (server) baseRevisions[key] = structuredClone(server.revision)
          })
          const batch: OfflineBatch = {
            id: crypto.randomUUID(),
            name,
            room,
            device,
            actor,
            createdAt: formatAt(),
            keys,
            baseSnapshot,
            baseRevisions,
            entries: [],
          }
          return { batch }
        }),

      /** 保存/更新本机离线记录：同一问题只保留一条（重复保存覆盖，recordId 幂等键不变） */
      saveEntry: (issueKey, draft) =>
        set((state) => {
          if (!state.batch) return state
          const existing = state.batch.entries.find((entry) => entry.issueKey === issueKey)
          // 已同步项不重做，避免同一问题产生第二条复测记录
          if (existing?.syncState === '已同步') return state
          const savedAt = formatAt()
          const nextEntry: OfflineEntry = existing
            ? { ...existing, ...draft, savedAt, syncState: '待提交', attempts: existing.attempts, lastError: undefined, conflict: undefined, appliedAt: undefined }
            : {
                id: crypto.randomUUID(),
                issueKey,
                recordId: `RT-OFF-${crypto.randomUUID().slice(0, 8)}`,
                ...draft,
                savedAt,
                syncState: '待提交',
                attempts: 0,
              }
          const entries = existing
            ? state.batch.entries.map((entry) => (entry.issueKey === issueKey ? nextEntry : entry))
            : [...state.batch.entries, nextEntry]
          return { batch: { ...state.batch, entries } }
        }),

      removeEntry: (issueKey) =>
        set((state) => {
          if (!state.batch) return state
          return { batch: { ...state.batch, entries: state.batch.entries.filter((entry) => entry.issueKey !== issueKey) } }
        }),

      abortBatch: () => set({ batch: null }),

      archiveBatch: () => {
        const { batch } = get()
        if (!batch || batch.entries.some((entry) => entry.syncState !== '已同步')) return
        set({ batch: null })
      },

      /**
       * 逐项恢复式同步：按批次固定顺序提交剩余项。
       * - 已同步 / 冲突待裁决项跳过（冲突必须先裁决，不能静默覆盖）；
       * - 冲突不阻断后续项；网络等失败立即中断，下次从第一个未完成项继续；
       * - 服务器按 recordId 幂等去重，中断重试不会产生重复复测记录。
       */
      syncBatch: async () => {
        const state = get()
        const summary = { autoMerged: [] as string[], deduped: [] as string[] }
        if (!state.batch || syncing) return summary
        syncing = true
        try {
          const batch = get().batch!
          for (const key of batch.keys) {
            const current = get().batch!.entries.find((entry) => entry.issueKey === key)
            if (!current || !ENTRY_STATES_TO_SYNC.includes(current.syncState)) continue

            const liveBatch = get().batch!
            const entry = liveBatch.entries.find((item) => item.issueKey === key)!
            const payload = buildPayload(liveBatch, entry, buildFields(entry))

            const mark = (patch: Partial<OfflineEntry>) =>
              set((s) => ({
                batch: s.batch
                  ? {
                      ...s.batch,
                      entries: s.batch.entries.map((item) => (item.issueKey === key ? { ...item, ...patch } : item)),
                    }
                  : s.batch,
              }))

            try {
              const data = await patchIssue(key, payload)
              if (data.deduplicated) summary.deduped.push(key)
              const localFields = new Set(entry.changedFields)
              const remoteOnly = data.remoteChanged.filter((change) => !localFields.has(change.field as RetestField))
              if (remoteOnly.length) summary.autoMerged.push(`${key}（${remoteOnly.map((change) => change.field).join('、')}）`)
              set((s) => ({
                serverIssues: s.serverIssues.map((item) => (item.key === data.issue.key ? structuredClone(data.issue) : item)),
                // 只确认这一项；其余有本机待合并记录的问题继续显示冻结版本
                issues: s.issues.map((item) => (item.key === data.issue.key ? stripRevision(data.issue) : item)),
                confirmedAt: formatAt(),
                lastSyncAt: formatAt(),
                batch: s.batch
                  ? {
                      ...s.batch,
                      syncedAt: data.deduplicated ? s.batch.syncedAt : formatAt(),
                      entries: s.batch.entries.map((item) =>
                        item.issueKey === key
                          ? {
                              ...item,
                              syncState: '已同步' as const,
                              attempts: item.attempts + 1,
                              lastError: undefined,
                              conflict: undefined,
                              appliedAt: formatAt(),
                            }
                          : item,
                      ),
                    }
                  : s.batch,
              }))
            } catch (error) {
              if (error instanceof ConflictError) {
                // 冲突挂起该项并继续后面的项；确认视图不更新，等待人工逐项裁决
                mark({ syncState: '冲突待裁决', conflict: error.conflict, attempts: entry.attempts + 1, lastError: undefined })
                continue
              }
              // 断网或服务器失败：中断整批，已成功的不回滚、不重做，恢复后从剩余项继续
              const message = error instanceof OfflineError ? '网络不可用，记录保留在本机' : `同步失败：${(error as Error).message}`
              mark({ syncState: '同步失败', attempts: entry.attempts + 1, lastError: message })
              break
            }
          }
        } finally {
          syncing = false
        }
        return summary
      },

      /**
       * 冲突裁决：逐字段选择"保留本机 / 采用远端"，不允许整单覆盖。
       * 冲突字段选远端的从提交中剔除（服务器保留远端版本），其余本人字段照常合并。
       */
      resolveConflict: async (issueKey, take) => {
        const state = get()
        const batch = state.batch
        const entry = batch?.entries.find((item) => item.issueKey === issueKey)
        if (!batch || !entry || !entry.conflict) return

        const conflictSet = new Set(entry.conflict.conflictFields)
        const fields: PatchFields = {}
        entry.changedFields.forEach((field) => {
          if (conflictSet.has(field) && take[field] !== 'local') return // 采用远端：不提交该字段
          const all = buildFields(entry)
          if (all[field] !== undefined) fields[field] = all[field] as never
        })

        // 用服务器当前版本作为新基线重新提交这一项
        const payload = {
          base: entry.conflict.current.revision,
          fields,
          record:
            Object.keys(fields).length > 0
              ? {
                  id: entry.recordId,
                  actor: batch.actor,
                  result: entry.result,
                  note: entry.note || '（详见备注）',
                  environment: entry.environment,
                  evidence: entry.evidence,
                }
              : null,
        }

        const mark = (patch: Partial<OfflineEntry>) =>
          set((s) => ({
            batch: s.batch
              ? { ...s.batch, entries: s.batch.entries.map((item) => (item.issueKey === issueKey ? { ...item, ...patch } : item)) }
              : s.batch,
          }))

        try {
          const data = await patchIssue(issueKey, payload)
          const chosenLocal = entry.conflict.conflictFields.filter((field) => take[field] === 'local').join('、') || '无'
          const chosenRemote = entry.conflict.conflictFields.filter((field) => take[field] === 'remote').join('、') || '无'
          const issueWithDecision: ServerIssue = {
            ...structuredClone(data.issue),
            history: [
              ...data.issue.history,
              {
                at: formatAt(),
                actor: batch.actor,
                action: '冲突裁决',
                detail: `保留本机字段：${chosenLocal}；采用远端字段：${chosenRemote}。裁决前未覆盖任何一方版本。`,
              },
            ],
          }
          set((s) => ({
            serverIssues: s.serverIssues.map((item) => (item.key === issueKey ? issueWithDecision : item)),
            issues: s.issues.map((item) => (item.key === issueKey ? stripRevision(issueWithDecision) : item)),
            confirmedAt: formatAt(),
            lastSyncAt: formatAt(),
            batch: s.batch
              ? {
                  ...s.batch,
                  entries: s.batch.entries.map((item) =>
                    item.issueKey === issueKey
                      ? { ...item, syncState: '已同步' as const, conflict: undefined, lastError: undefined, appliedAt: formatAt() }
                      : item,
                  ),
                }
              : s.batch,
          }))
        } catch (error) {
          if (error instanceof ConflictError) {
            // 裁决期间另一端又改了：刷新冲突事实，继续人工裁决，不覆盖
            mark({ syncState: '冲突待裁决', conflict: error.conflict })
            throw error
          }
          mark({ syncState: '同步失败', lastError: `裁决提交失败：${(error as Error).message}` })
          throw error
        }
      },

      setIssues: (issues) => set({ issues }),
      setSelectedKeys: (selectedKeys) => set({ selectedKeys }),
      saveFilter: (filter) => set((s) => ({ savedFilters: [...s.savedFilters, { ...filter, id: crypto.randomUUID() }] })),
      removeFilter: (id) => set((s) => ({ savedFilters: s.savedFilters.filter((item) => item.id !== id) })),
      setDraft: (draft) => set({ draft }),
      mergeIssues: (keys) =>
        set((state) => {
          const primary = state.issues.find((issue) => issue.key === keys[0])
          if (!primary) return state
          return {
            issues: state.issues.map((issue) =>
              keys.includes(issue.key)
                ? {
                    ...issue,
                    rootCause: primary.rootCause,
                    status: issue.key === primary.key ? issue.status : '不适用',
                    mergedKeys: issue.key === primary.key ? keys.slice(1) : [primary.key],
                    history: [...issue.history, { at: formatAt(), actor: '当前用户', action: '重复问题合并', detail: `合并至 ${primary.key}` }],
                  }
                : issue,
            ),
            selectedKeys: [],
          }
        }),
      updateIssue: (updated) => set((state) => ({ issues: state.issues.map((issue) => (issue.key === updated.key ? updated : issue)) })),
    }),
    {
      name: 'offline-retest-v2',
      version: 2,
      partialize: (state) => ({
        // 断网记录全部留在本机：批次、确认视图、确认时间与筛选偏好持久化
        serverIssues: state.serverIssues,
        issues: state.issues,
        confirmedAt: state.confirmedAt,
        lastSyncAt: state.lastSyncAt,
        batch: state.batch,
        selectedKeys: state.selectedKeys,
        savedFilters: state.savedFilters,
        draft: state.draft,
      }),
    },
  ),
)

/** 本批是否仍有未完成的冲突（台账 / 版本差异 / 报告据此保持冻结） */
export function selectHasOpenConflict(batch: OfflineBatch | null): boolean {
  return Boolean(batch?.entries.some((entry) => entry.syncState === '冲突待裁决'))
}

/** 远端在基线后改过、但本机未改的字段（自动并入，需要在界面上告知复测员） */
export function selectRemoteOnlyChanges(entry: OfflineEntry | undefined): { field: WatchedField; actor: string; at: string }[] {
  if (!entry?.conflict) return []
  const local = new Set(entry.changedFields)
  return entry.conflict.remoteChanged.filter((change) => !local.has(change.field as RetestField))
}
