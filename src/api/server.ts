import { delay, http, HttpResponse } from 'msw'
import { seedIssues } from './seed'
import { formatAt } from '../lib/time'
import type {
  ConflictResponse,
  FieldRev,
  IssueRevisions,
  PatchOk,
  PatchPayload,
  RemoteChangeInfo,
  RetestField,
  ServerIssue,
  WatchedField,
} from './types'

let issues: ServerIssue[] = structuredClone(seedIssues)

const bump = (revision: FieldRev, actor: string, at: string): FieldRev => ({ rev: revision.rev + 1, actor, at })

const bumpField = (issue: ServerIssue, field: WatchedField, actor: string, at: string) => {
  issue.revision[field] = bump(issue.revision[field], actor, at)
}

/** 找出基线之后远端发生过变化的字段 */
function changedSince(base: IssueRevisions, current: IssueRevisions): RemoteChangeInfo[] {
  const result: RemoteChangeInfo[] = []
  ;(Object.keys(current) as WatchedField[]).forEach((field) => {
    if (current[field].rev > (base[field]?.rev ?? 1)) {
      result.push({ field, actor: current[field].actor, at: current[field].at })
    }
  })
  return result
}

export const handlers = [
  http.get('*/api/issues', ({ request }) => {
    const url = new URL(request.url)
    const query = url.searchParams.get('query')?.toLowerCase() ?? ''
    const status = url.searchParams.get('status') ?? ''
    const site = url.searchParams.get('site') ?? ''
    const filtered = issues.filter(
      (issue) =>
        (!query || `${issue.key}${issue.title}${issue.rootCause}`.toLowerCase().includes(query)) &&
        (!status || issue.status === status) &&
        (!site || issue.site === site),
    )
    return HttpResponse.json(filtered)
  }),

  /**
   * 逐项合并复测结论。
   * - fields 只包含本人改过的字段；
   * - record.id 幂等，重试返回 deduplicated: true，不产生重复复测记录；
   * - 某字段基线 rev < 服务器 rev 且本机也改了它 → 该字段冲突，整体 409，不写入任何内容。
   */
  http.patch('*/api/issues/:key', async ({ params, request }) => {
    const issue = issues.find((item) => item.key === params.key)
    if (!issue) return new HttpResponse(null, { status: 404 })
    const payload = (await request.json()) as PatchPayload
    const at = formatAt()
    await delay(350)

    // 幂等：同一 recordId 已合并过，直接返回当前版本（重试/重复提交不产生第二条记录）
    const incomingRecordId = payload.record?.id
    if (incomingRecordId && issue.retestRecords.some((record) => record.id === incomingRecordId)) {
      return HttpResponse.json({
        ok: true,
        issue,
        deduplicated: true,
        remoteChanged: changedSince(payload.base, issue.revision),
      } satisfies PatchOk)
    }

    const localFields = Object.keys(payload.fields) as RetestField[]
    const conflictFields = localFields.filter((field) => issue.revision[field].rev > (payload.base[field]?.rev ?? 1))

    if (conflictFields.length) {
      const body: ConflictResponse = {
        error: 'CONFLICT',
        issueKey: issue.key,
        current: structuredClone(issue),
        conflictFields,
        remoteChanged: changedSince(payload.base, issue.revision),
      }
      return HttpResponse.json(body, { status: 409 })
    }

    const actor = payload.record?.actor ?? '复测员'
    const remoteChanged = changedSince(payload.base, issue.revision)

    if (payload.fields.status !== undefined) {
      issue.status = payload.fields.status
      bumpField(issue, 'status', actor, at)
    }
    if (payload.fields.retestEnv !== undefined) {
      issue.retestEnv = payload.fields.retestEnv
      bumpField(issue, 'retestEnv', actor, at)
    }
    if (payload.fields.retestEvidence !== undefined) {
      issue.retestEvidence = payload.fields.retestEvidence
      bumpField(issue, 'retestEvidence', actor, at)
    }
    if (payload.fields.retestNote !== undefined) {
      bumpField(issue, 'retestNote', actor, at)
    }

    if (payload.record) {
      const { id, actor: recordActor, result, note, environment, evidence } = payload.record
      issue.retestRecords.push({ id, actor: recordActor, result, note, at, environment, evidence })
      issue.history.push({ at, actor: recordActor, action: `复测${result}`, detail: note })
    }

    return HttpResponse.json({ ok: true, issue: structuredClone(issue), deduplicated: false, remoteChanged } satisfies PatchOk)
  }),

  http.post('*/api/issues/bulk-assign', async ({ request }) => {
    const body = (await request.json()) as { keys: string[]; team: string; owner: string; dueDate: string; priority: string }
    const at = formatAt()
    issues = issues.map((issue) =>
      body.keys.includes(issue.key)
        ? {
            ...issue,
            team: body.team,
            owner: body.owner,
            dueDate: body.dueDate,
            priority: body.priority as ServerIssue['priority'],
            status: '修复中',
            revision: { ...issue.revision, status: bump(issue.revision.status, '当前用户', at) },
            history: [...issue.history, { at, actor: '当前用户', action: '批量分配', detail: `指派至 ${body.team} / ${body.owner}` }],
          }
        : issue,
    )
    return HttpResponse.json({ updated: body.keys.length })
  }),

  /**
   * 演练用：模拟"断网期间开发或另一名复测员在另一端改了同一问题"。
   * 该请求表示他人操作，不受本机断网开关影响；重复调用不会再次制造变更。
   */
  http.post('*/api/dev/simulate-remote', async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { keys?: string[] }
    const keys = body.keys ?? ['A11Y-1048', 'A11Y-1074', 'A11Y-1083']
    const touched: string[] = []

    const edit = (issue: ServerIssue | undefined, apply: (issue: ServerIssue, at: string) => void) => {
      if (!issue || touched.includes(issue.key)) return
      const at = formatAt(Date.now() + touched.length)
      apply(issue, at)
      touched.push(issue.key)
    }

    // 另一名复测员在同一问题上给出了相反结论（状态字段冲突）
    edit(
      issues.find((item) => item.key === 'A11Y-1048' && keys.includes(item.key)),
      (issue, at) => {
        const actor = '陈舟 / 另一名复测员'
        issue.status = '已通过'
        issue.retestRecords.push({
          id: `RT-REMOTE-${Date.now()}-1048`,
          actor: '陈舟',
          result: '通过',
          note: 'Esc 关闭、Tab/Shift+Tab 顺序与焦点返回均验证通过（会议室另一台电脑复测）。',
          at,
          environment: 'Edge 140 / 商城 Web v4.18.3',
          evidence: 'edge-keyboard-check.mp4',
        })
        issue.retestEnv = 'Edge 140 / 商城 Web v4.18.3'
        issue.retestEvidence = 'edge-keyboard-check.mp4'
        issue.history.push({ at, actor, action: '复测已通过', detail: '另一端已完成复测并通过。' })
        issue.revision = {
          ...issue.revision,
          status: bump(issue.revision.status, actor, at),
          retestEnv: bump(issue.revision.retestEnv, actor, at),
          retestEvidence: bump(issue.revision.retestEvidence, actor, at),
          retestNote: bump(issue.revision.retestNote, actor, at),
        }
      },
    )

    // 开发补充了修复说明（本机没改该字段 → 自动并入，不覆盖本机结论）；
    // 同时另有复测员通过（本机若也给了结论 → 状态冲突）
    edit(
      issues.find((item) => item.key === 'A11Y-1074' && keys.includes(item.key)),
      (issue, at) => {
        const dev = '赵屿 / 数据可视化组'
        const tester = '陈舟 / 另一名复测员'
        issue.rootCause = '图表主题色板未执行无障碍校验；虚线纹理缺少非颜色含义标注'
        issue.fixNote = '更换色板（对比度 ≥ 4.5:1）、增加虚线纹理图例，并提供可切换数据表。'
        issue.status = '已通过'
        issue.retestRecords.push({
          id: `RT-REMOTE-${Date.now()}-1074`,
          actor: '陈舟',
          result: '通过',
          note: '对比度工具实测 5.2:1，纹理与数据表均可访问。',
          at,
          environment: 'Safari 26 / 对比度工具 / admin-v2.7.6',
          evidence: 'contrast-5.2-report.png',
        })
        issue.history.push({ at, actor: dev, action: '更新修复说明', detail: '补充纹理图例与数据表说明。' })
        issue.history.push({ at, actor: tester, action: '复测已通过', detail: '另一端复测通过。' })
        issue.revision = {
          ...issue.revision,
          rootCause: bump(issue.revision.rootCause, dev, at),
          fixNote: bump(issue.revision.fixNote, dev, at),
          status: bump(issue.revision.status, tester, at),
          retestNote: bump(issue.revision.retestNote, tester, at),
        }
      },
    )

    // 开发重写了修复方案（根因/修复说明为远端独有变更，自动并入，不阻断本机复测提交）
    edit(
      issues.find((item) => item.key === 'A11Y-1083' && keys.includes(item.key)),
      (issue, at) => {
        const dev = '顾雪 / 供应链前端组'
        issue.rootCause = '表单错误组件未接入 aria-live；字段 aria-describedby 指向了视觉占位节点'
        issue.fixNote = '接入 aria-live="polite"，错误文案改为 aria-describedby 关联，并补充焦点定位。'
        issue.history.push({ at, actor: dev, action: '更新修复方案', detail: '按退回意见重写 aria-live 与 describedby 方案，等待复测。' })
        issue.revision = {
          ...issue.revision,
          rootCause: bump(issue.revision.rootCause, dev, at),
          fixNote: bump(issue.revision.fixNote, dev, at),
        }
      },
    )

    return HttpResponse.json({ touched })
  }),
]

export { issues }
