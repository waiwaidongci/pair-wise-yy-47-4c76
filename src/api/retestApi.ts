import axios from 'axios'
import type { ConflictField, Issue, OutboxEntry } from './types'

export type SyncResult =
  | { entryId: string; status: 'synced'; issue: Issue }
  | { entryId: string; status: 'conflict'; issue: Issue; fields: ConflictField[] }

/** 逐项合并：只提交本人改过的字段，服务端按 base 快照做冲突检测 */
export async function syncEntry(entry: OutboxEntry): Promise<SyncResult> {
  const { data } = await axios.post('/api/retest/sync', {
    entryId: entry.id,
    issueKey: entry.issueKey,
    baseIssue: entry.baseIssue,
    patch: entry.patch,
  })
  return data as SyncResult
}

/** 冲突处理后提交最终结论；accept=false 表示采用对方版本（丢弃本人记录） */
export async function resolveEntry(
  entry: OutboxEntry,
  accept: boolean,
  choices: Record<string, 'ours' | 'theirs'>,
): Promise<Issue> {
  const { data } = await axios.post('/api/retest/resolve', {
    entryId: entry.id,
    issueKey: entry.issueKey,
    accept,
    choices,
    baseIssue: entry.baseIssue,
    patch: entry.patch,
  })
  return (data as { issue: Issue }).issue
}

/** 开发/另一名复测员并发修改（演示用） */
export async function simulateChange(key?: string): Promise<{ issue: Issue; changes: string[] }> {
  const { data } = await axios.post('/api/dev/simulate-change', { key })
  return data as { issue: Issue; changes: string[] }
}

/** 通知 MSW 切换网络通断（演示断网/恢复） */
export async function setNetworkOffline(offline: boolean): Promise<void> {
  await axios.post('/api/dev/network', { offline })
}
