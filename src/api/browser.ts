import { setupWorker } from 'msw/browser'
import { http, HttpResponse } from 'msw'
import { seedIssues } from './seed'
import type { ConflictField, Issue, RetestPatch } from './types'

let issues = structuredClone(seedIssues)
let offline = false

const networkError = () => HttpResponse.error()

/** 以录制时的服务端快照为基线，检测对方是否改过状态或根因 */
function detectConflicts(issue: Issue, base: Issue, patch: RetestPatch): ConflictField[] {
  const fields: ConflictField[] = []
  if (issue.status !== base.status && patch.result !== base.status) {
    fields.push({ field: 'status', label: '复测结论 / 状态', base: base.status, ours: patch.result, theirs: issue.status })
  }
  if (issue.rootCause !== base.rootCause) {
    fields.push({ field: 'rootCause', label: '根因', base: base.rootCause, ours: base.rootCause, theirs: issue.rootCause })
  }
  return fields
}

/** 只应用本人改过的字段：状态、复测环境、复测记录与历史 */
function applyPatch(issue: Issue, patch: RetestPatch, actor: string, actionPrefix: string) {
  issue.status = patch.result
  issue.retestEnv = patch.environment
  const note = patch.evidence ? `${patch.note}\n证据：${patch.evidence}` : patch.note
  issue.retestRecords.push({
    id: `RT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    actor,
    result: patch.result,
    note,
    at: new Date().toLocaleString('zh-CN', { hour12: false }),
    evidence: patch.evidence || undefined,
  })
  issue.history.push({ at: '刚刚', actor, action: `${actionPrefix}${patch.result}`, detail: note })
}

export const worker = setupWorker(
  http.get('/api/issues', ({ request }) => {
    if (offline) return networkError()
    const url = new URL(request.url)
    const query = url.searchParams.get('query')?.toLowerCase() ?? ''
    const status = url.searchParams.get('status') ?? ''
    const site = url.searchParams.get('site') ?? ''
    const filtered = issues.filter((issue) => (!query || `${issue.key}${issue.title}${issue.rootCause}`.toLowerCase().includes(query)) && (!status || issue.status === status) && (!site || issue.site === site))
    return HttpResponse.json(filtered)
  }),
  http.post('/api/issues/:key/review', async ({ params, request }) => {
    if (offline) return networkError()
    const issue = issues.find((item) => item.key === params.key)
    const body = (await request.json()) as { result: string; note: string; environment: string }
    if (!issue) return new HttpResponse(null, { status: 404 })
    issue.status = body.result as Issue['status']
    issue.retestEnv = body.environment
    issue.retestRecords.push({ id: `RT-${Date.now()}`, actor: '当前用户', result: body.result, note: body.note, at: '刚刚' })
    issue.history.push({ at: '刚刚', actor: '当前用户', action: `复测${body.result}`, detail: body.note })
    return HttpResponse.json(issue)
  }),
  http.post('/api/issues/bulk-assign', async ({ request }) => {
    if (offline) return networkError()
    const body = (await request.json()) as { keys: string[]; team: string; owner: string; dueDate: string; priority: string }
    issues = issues.map((issue) =>
      body.keys.includes(issue.key)
        ? { ...issue, team: body.team, owner: body.owner, dueDate: body.dueDate, priority: body.priority as Issue['priority'], status: '修复中', history: [...issue.history, { at: '刚刚', actor: '当前用户', action: '批量分配', detail: `指派至 ${body.team} / ${body.owner}` }] }
        : issue,
    )
    return HttpResponse.json({ updated: body.keys.length })
  }),
  http.post('/api/retest/sync', async ({ request }) => {
    if (offline) return networkError()
    const body = (await request.json()) as { entryId: string; issueKey: string; baseIssue: Issue; patch: RetestPatch }
    const issue = issues.find((item) => item.key === body.issueKey)
    if (!issue) return HttpResponse.json({ entryId: body.entryId, status: 'error', error: '问题不存在' }, { status: 404 })
    const fields = detectConflicts(issue, body.baseIssue, body.patch)
    if (fields.length) {
      return HttpResponse.json({ entryId: body.entryId, status: 'conflict', issue: structuredClone(issue), fields })
    }
    applyPatch(issue, body.patch, '当前用户（离线补录）', '复测')
    return HttpResponse.json({ entryId: body.entryId, status: 'synced', issue: structuredClone(issue) })
  }),
  http.post('/api/retest/resolve', async ({ request }) => {
    if (offline) return networkError()
    const body = (await request.json()) as {
      entryId: string
      issueKey: string
      accept: boolean
      choices: Record<string, 'ours' | 'theirs'>
      baseIssue: Issue
      patch: RetestPatch
    }
    const issue = issues.find((item) => item.key === body.issueKey)
    if (!issue) return HttpResponse.json({ error: '问题不存在' }, { status: 404 })
    if (!body.accept) {
      // 采用对方版本：不覆盖任何字段
      return HttpResponse.json({ entryId: body.entryId, status: 'synced', issue: structuredClone(issue) })
    }
    const choices = body.choices ?? {}
    if (choices.status !== 'theirs') issue.status = body.patch.result
    if (choices.rootCause === 'ours') issue.rootCause = body.baseIssue.rootCause
    issue.retestEnv = body.patch.environment
    const note = body.patch.evidence ? `${body.patch.note}\n证据：${body.patch.evidence}` : body.patch.note
    issue.retestRecords.push({
      id: `RT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      actor: '当前用户（离线补录）',
      result: body.patch.result,
      note,
      at: new Date().toLocaleString('zh-CN', { hour12: false }),
      evidence: body.patch.evidence || undefined,
    })
    issue.history.push({ at: '刚刚', actor: '当前用户（离线补录）', action: `复测${body.patch.result}（冲突已处理）`, detail: note })
    return HttpResponse.json({ entryId: body.entryId, status: 'synced', issue: structuredClone(issue) })
  }),
  http.post('/api/dev/network', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { offline?: boolean }
    offline = Boolean(body.offline)
    return HttpResponse.json({ offline })
  }),
  http.post('/api/dev/simulate-change', async ({ request }) => {
    if (offline) return networkError()
    const body = (await request.json().catch(() => ({}))) as { key?: string }
    const target = body.key ? issues.find((item) => item.key === body.key) : issues.find((item) => item.status === '待复测') ?? issues[0]
    if (!target) return HttpResponse.json({ error: '问题不存在' }, { status: 404 })
    const changes: string[] = []
    if (target.status === '待复测') {
      target.status = '修复中'
      changes.push('status')
    } else if (target.status === '修复中') {
      target.status = '待复测'
      changes.push('status')
    }
    target.rootCause = `${target.rootCause}（开发复核后更新）`
    changes.push('rootCause')
    target.history.push({ at: '刚刚', actor: '开发 / 另一名复测员', action: '并发修改', detail: `模拟另一端变更：${changes.join('、')}` })
    return HttpResponse.json({ issue: structuredClone(target), changes })
  }),
)

export { issues }
