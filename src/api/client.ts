import axios, { AxiosError } from 'axios'
import { isOnline } from '../lib/network'
import type { ConflictResponse, PatchPayload, PatchOk, ServerIssue } from './types'

export class OfflineError extends Error {
  constructor() {
    super('当前处于离线状态，记录已保存在本机，网络恢复后可继续同步。')
    this.name = 'OfflineError'
  }
}

export class ConflictError extends Error {
  conflict: ConflictResponse
  constructor(conflict: ConflictResponse) {
    super(`A11Y ${conflict.issueKey} 存在待裁决冲突`)
    this.name = 'ConflictError'
    this.conflict = conflict
  }
}

const http = axios.create({ timeout: 8000 })

/** 断网时不真正发请求，直接以离线错误失败（数据仍保存在本机批次中） */
function ensureOnline() {
  if (!isOnline()) throw new OfflineError()
}

export async function fetchIssues(): Promise<ServerIssue[]> {
  ensureOnline()
  return (await http.get<ServerIssue[]>('/api/issues')).data
}

/**
 * 逐项合并本机复测记录。
 * 只发送本人改过的字段；409 时抛出 ConflictError 由同步队列挂起该项等待裁决。
 */
export async function patchIssue(key: string, payload: PatchPayload): Promise<PatchOk> {
  ensureOnline()
  try {
    return (await http.patch<PatchOk>(`/api/issues/${key}`, payload)).data
  } catch (error) {
    const axiosError = error as AxiosError<ConflictResponse>
    if (axiosError.response?.status === 409 && axiosError.response.data) {
      throw new ConflictError(axiosError.response.data)
    }
    throw error
  }
}

/** 演练用：模拟断网期间另一端的并发修改（代表他人操作，不受本机断网开关影响） */
export async function simulateRemoteEdits(keys?: string[]): Promise<{ touched: string[] }> {
  return (await http.post<{ touched: string[] }>('/api/dev/simulate-remote', { keys })).data
}

export async function bulkAssign(payload: { keys: string[]; team: string; owner: string; dueDate: string; priority: string }) {
  ensureOnline()
  return http.post('/api/issues/bulk-assign', payload)
}
