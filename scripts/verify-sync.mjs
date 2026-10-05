import assert from 'node:assert/strict'
import { setupServer } from 'msw/node'
import { handlers } from '../src/api/server'

const server = setupServer(...handlers)

let passed = 0
const ok = (name) => { console.log(`  ✓ ${name}`); passed++ }

const json = (res) => ({ 'Content-Type': 'application/json', body: JSON.stringify(res) })

async function patchIssue(key, payload) {
  const res = await fetch(`http://localhost/api/issues/${key}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  return { status: res.status, data }
}

async function simulateRemote(keys) {
  await fetch('http://localhost/api/dev/simulate-remote', {
    method: 'POST',
    ...json({ keys }),
  })
}

async function getIssue(key) {
  const res = await fetch(`http://localhost/api/issues`)
  const list = await res.json()
  return list.find((i) => i.key === key)
}

const baseOf = async (key) => (await getIssue(key)).revision
const recordId = 'RT-OFF-TEST-001'

server.listen({ onUnhandledRequest: 'warn' })

try {
  console.log('场景 1：干净逐项合并（A11Y-1048，无远端并发）')
  {
    const base = await baseOf('A11Y-1048')
    const payload = {
      base,
      fields: { status: '已通过', retestEnv: 'Chrome 140 / v4.18.3', retestEvidence: 'a.mp4', retestNote: '键盘验证通过' },
      record: { id: recordId, actor: '本机复测员', result: '已通过', note: '键盘验证通过', environment: 'Chrome 140 / v4.18.3', evidence: 'a.mp4' },
    }
    const r1 = await patchIssue('A11Y-1048', payload)
    assert.equal(r1.status, 200)
    assert.equal(r1.data.issue.status, '已通过')
    assert.equal(r1.data.deduplicated, false)
    ok('首次合并成功，只提交本人字段')

    // 模拟同步中断后的重试：同一 recordId
    const r2 = await patchIssue('A11Y-1048', payload)
    assert.equal(r2.status, 200)
    assert.equal(r2.data.deduplicated, true)
    const after = await getIssue('A11Y-1048')
    assert.equal(after.retestRecords.filter((r) => r.id === recordId).length, 1)
    ok('重试幂等去重：不产生第二条复测记录')
  }

  console.log('场景 2：断网期间另一端也改了同一问题（A11Y-1074）→ 状态字段冲突 409')
  {
    const base = await baseOf('A11Y-1074')
    await simulateRemote(['A11Y-1074'])
    const payload = {
      base,
      fields: { status: '已退回', retestEnv: 'Safari 26 / admin-v2.7.5', retestEvidence: 'b.png', retestNote: '纹理仍无文本标注，退回' },
      record: { id: 'RT-OFF-TEST-002', actor: '本机复测员', result: '已退回', note: '纹理仍无文本标注，退回', environment: 'Safari 26 / admin-v2.7.5', evidence: 'b.png' },
    }
    const r = await patchIssue('A11Y-1074', payload)
    assert.equal(r.status, 409)
    assert.equal(r.data.error, 'CONFLICT')
    assert.ok(r.data.conflictFields.includes('status'))
    ok('409 列出冲突字段 status，未写入任何内容（本机与远端都不被覆盖）')
    const issueAfter409 = await getIssue('A11Y-1074')
    assert.equal(issueAfter409.status, '已通过', '服务器仍保留远端版本')
    assert.ok(!issueAfter409.retestRecords.some((x) => x.id === 'RT-OFF-TEST-002'), '本机记录未泄漏')
    ok('冲突期间服务器保持远端版本，本机记录待裁决')

    // 远端独有的根因/修复说明变更应出现在 remoteChanged
    assert.ok(r.data.remoteChanged.some((c) => c.field === 'rootCause'))
    assert.ok(r.data.remoteChanged.some((c) => c.field === 'fixNote'))
    ok('远端独有变更（根因、修复说明）通过 remoteChanged 告知，将自动并入')

    console.log('  裁决：本机坚持退回结论（status 保留本机），其余字段采用远端 → 以新基线重提')
    const current = r.data.current
    const resolved = {
      base: current.revision,
      fields: { status: '已退回' },
      record: { id: 'RT-OFF-TEST-002', actor: '本机复测员', result: '已退回', note: '纹理仍无文本标注，退回', environment: 'Safari 26 / admin-v2.7.5', evidence: 'b.png' },
    }
    const r2 = await patchIssue('A11Y-1074', resolved)
    assert.equal(r2.status, 200)
    assert.equal(r2.data.issue.status, '已退回')
    // 远端独有的修复说明仍在（自动并入，未被本机覆盖）
    assert.match(r2.data.issue.fixNote, /aria|数据表|纹理图例/)
    assert.match(r2.data.issue.rootCause, /非颜色含义标注/)
    ok('逐字段裁决成功：本机结论生效，远端根因/修复说明保留，未整单覆盖')
    assert.equal(r2.data.issue.retestRecords.filter((x) => x.id === 'RT-OFF-TEST-002').length, 1)
  }

  console.log('场景 3：远端只改了根因/修复说明，本机复测结论不冲突（A11Y-1083）→ 干净合并 + 自动并入')
  {
    const base = await baseOf('A11Y-1083')
    await simulateRemote(['A11Y-1083'])
    const payload = {
      base,
      fields: { status: '已通过', retestNote: 'aria-live 已播报，通过' },
      record: { id: 'RT-OFF-TEST-003', actor: '本机复测员', result: '已通过', note: 'aria-live 已播报，通过', environment: 'NVDA 2026.1 / portal-v1.12.4', evidence: 'c.mp3' },
    }
    const r = await patchIssue('A11Y-1083', payload)
    assert.equal(r.status, 200)
    assert.equal(r.data.issue.status, '已通过')
    assert.match(r.data.issue.fixNote, /aria-live="polite"/)
    assert.ok(r.data.remoteChanged.some((c) => c.field === 'rootCause'))
    ok('本机结论干净合并，远端修复方案自动并入，无冲突阻断')
  }

  console.log('场景 4：另一复测员先通过（A11Y-1048）→ 本机再提交不同结论产生冲突，而非静默覆盖')
  {
    const base = await baseOf('A11Y-1048') // 此时 rev 已含本机第一次通过
    await simulateRemote(['A11Y-1048']) // 另一复测员再次通过（幂等：已存在则跳过）
    // 手工构造一个落后基线 + 不同结论，模拟"另一台电脑"的并发
    const staleBase = { ...base, status: { rev: base.status.rev - 1, actor: 'old', at: 'old' } }
    const payload = {
      base: staleBase,
      fields: { status: '已退回' },
      record: { id: 'RT-OFF-TEST-004', actor: '本机复测员', result: '已退回', note: '复测退回', environment: 'x', evidence: 'y' },
    }
    const r = await patchIssue('A11Y-1048', payload)
    assert.equal(r.status, 409)
    assert.ok(r.data.conflictFields.includes('status'))
    ok('同一问题双方结论不同 → 409 挂起，必须人工裁决，不会覆盖')
  }

  console.log(`\n全部 ${passed} 项断言通过`)
} catch (error) {
  console.error('测试失败：', error)
  process.exitCode = 1
} finally {
  server.close()
}
