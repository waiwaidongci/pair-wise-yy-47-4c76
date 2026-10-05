export type IssueStatus = '待分配' | '修复中' | '待复测' | '已通过' | '已退回' | '不适用'

/** 复测员可给出的结论（结论变化会驱动问题状态） */
export type RetestResult = '已通过' | '已退回' | '不适用'

export type HistoryEvent = { at: string; actor: string; action: string; detail: string }

export type RetestRecord = {
  id: string
  actor: string
  result: string
  note: string
  at: string
  environment?: string
  evidence?: string
}

export type Issue = {
  key: string
  title: string
  site: string
  version: string
  wcag: string[]
  issueType: string
  impact: '致命' | '严重' | '中等' | '轻微'
  affected: string
  reproduction: string
  evidence: string
  rootCause: string
  status: IssueStatus
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  team: string
  owner: string
  dueDate: string
  mergedKeys: string[]
  fixNote?: string
  retestEnv?: string
  /** 复测留下的证据（截图 / 录屏 / 播报日志链接），区别于问题录入时的 evidence */
  retestEvidence?: string
  retestRecords: RetestRecord[]
  history: HistoryEvent[]
}

/* ------------------------------------------------------------------ */
/* 服务器端：字段级版本号，用于"只提交本人改过的字段"与三方冲突检测      */
/* ------------------------------------------------------------------ */

export type FieldRev = { rev: number; actor: string; at: string }

/** 每个被并发保护的字段各自维护版本号 */
export type IssueRevisions = {
  status: FieldRev
  rootCause: FieldRev
  fixNote: FieldRev
  retestEnv: FieldRev
  retestEvidence: FieldRev
  retestNote: FieldRev
}

export type ServerIssue = Issue & { revision: IssueRevisions }

/** 复测员在本批中可能改动的字段（PATCH 只允许出现这些字段） */
export type RetestField = 'status' | 'retestEnv' | 'retestEvidence' | 'retestNote'

/** 全部参与版本比对的字段（含开发会改的根因、修复说明） */
export type WatchedField = RetestField | 'rootCause' | 'fixNote'

export type PatchFields = {
  status?: RetestResult
  retestEnv?: string
  retestEvidence?: string
  retestNote?: string
}

/** 逐项合并请求：基线版本 + 本人改过的字段 + 幂等复测记录 */
export type PatchPayload = {
  base: IssueRevisions
  fields: PatchFields
  record: {
    id: string
    actor: string
    result: RetestResult
    note: string
    environment: string
    evidence: string
  } | null
}

export type PatchOk = {
  ok: true
  issue: ServerIssue
  /** true 表示该 recordId 之前已合并过，本次为重试去重，没有产生重复记录 */
  deduplicated: boolean
  /** 远端在基线后改过、但本次本机未提交的字段（自动并入，需要告知复测员） */
  remoteChanged: RemoteChangeInfo[]
}

export type RemoteChangeInfo = { field: WatchedField; actor: string; at: string }

/** 409 冲突响应：服务器不裁决，只摆事实 */
export type ConflictResponse = {
  error: 'CONFLICT'
  issueKey: string
  current: ServerIssue
  /** 本机改过、远端基线后也改过的字段——必须逐字段裁决 */
  conflictFields: RetestField[]
  /** 远端在基线后改过的全部字段（含本机没碰、将自动保留远端版本的字段） */
  remoteChanged: RemoteChangeInfo[]
}

/* ------------------------------------------------------------------ */
/* 本机离线复测批次                                                     */
/* ------------------------------------------------------------------ */

export type EntrySyncState = '待提交' | '同步失败' | '冲突待裁决' | '已同步'

/** 一条本机离线复测记录（同一问题只保留一条，重复保存覆盖更新，recordId 不变） */
export type OfflineEntry = {
  id: string
  issueKey: string
  /** 幂等键：网络重试 / 刷新页面都不会产生重复复测记录 */
  recordId: string
  result: RetestResult
  environment: string
  evidence: string
  note: string
  /** 本人本批改过的字段，提交时只发送这些字段 */
  changedFields: RetestField[]
  savedAt: string
  syncState: EntrySyncState
  attempts: number
  lastError?: string
  appliedAt?: string
  conflict?: ConflictResponse
}

export type OfflineBatch = {
  id: string
  name: string
  room: string
  device: string
  actor: string
  createdAt: string
  /** 批次纳入的问题，固定顺序，同步按此顺序逐项恢复 */
  keys: string[]
  /** 批次开始时的确认版本快照（冲突比对中的"上一个确认版本"） */
  baseSnapshot: Record<string, Issue>
  /** 批次开始时各问题的字段级版本号 */
  baseRevisions: Record<string, IssueRevisions>
  entries: OfflineEntry[]
  syncedAt?: string
}

export const RETEST_FIELD_LABEL: Record<WatchedField, string> = {
  status: '状态 / 复测结论',
  retestEnv: '复测环境',
  retestEvidence: '复测证据',
  retestNote: '复测备注',
  rootCause: '根因',
  fixNote: '修复说明',
}
