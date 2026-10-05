export type IssueStatus = '待分配' | '修复中' | '待复测' | '已通过' | '已退回' | '不适用'

export type RetestResult = '已通过' | '已退回' | '不适用'

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
  retestRecords: Array<{ id: string; actor: string; result: string; note: string; at: string; evidence?: string }>
  history: Array<{ at: string; actor: string; action: string; detail: string }>
}

/** 复测员本次提交的字段（只提交本人改过的字段） */
export type RetestPatch = {
  result: RetestResult
  note: string
  environment: string
  evidence: string
}

export type EntryStatus = 'pending' | 'syncing' | 'synced' | 'conflict' | 'failed'

export type ConflictFieldName = 'status' | 'rootCause'

export type ConflictField = {
  field: ConflictFieldName
  label: string
  base: string
  ours: string
  theirs: string
}

/** 一条离线复测记录：包含录制时的服务端快照（确认版本）与本人修改字段 */
export type OutboxEntry = {
  id: string
  batchId: string
  issueKey: string
  issueTitle: string
  baseIssue: Issue
  patch: RetestPatch
  createdAt: string
  status: EntryStatus
  error?: string
  conflictFields?: ConflictField[]
  serverIssue?: Issue
}

export type RetestBatch = {
  id: string
  name: string
  createdAt: string
  status: 'open' | 'done'
}
