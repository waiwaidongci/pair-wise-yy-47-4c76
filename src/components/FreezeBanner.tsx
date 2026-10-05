import { Alert, Space, Tag } from 'antd'
import { useNavigate } from 'react-router-dom'
import { useWorkspaceStore, selectHasOpenConflict } from '../store/useWorkspaceStore'

/**
 * 有活动离线批次（尤其存在未裁决冲突）时，
 * 问题台账 / 版本差异 / 整改报告继续显示上一个确认版本，不显示合并后的中间状态。
 */
export default function FreezeBanner() {
  const batch = useWorkspaceStore((state) => state.batch)
  const confirmedAt = useWorkspaceStore((state) => state.confirmedAt)
  const navigate = useNavigate()
  if (!batch) return null

  const pending = batch.entries.filter((entry) => ['待提交', '同步失败'].includes(entry.syncState)).length
  const synced = batch.entries.filter((entry) => entry.syncState === '已同步').length
  const conflict = selectHasOpenConflict(batch)
  const conflictCount = batch.entries.filter((entry) => entry.syncState === '冲突待裁决').length

  return (
    <Alert
      style={{ marginBottom: 12 }}
      type={conflict ? 'error' : 'warning'}
      showIcon
      action={<a onClick={() => navigate('/retest')}>返回复测工作台处理 →</a>}
      message={
        <Space wrap>
          {conflict ? (
            <>
              <Tag color="error">有 {conflictCount} 项冲突未裁决</Tag>
              <span>
                本页继续显示<b>上一个确认版本</b>（确认于 {confirmedAt}），冲突逐项裁决完成后才会更新，任何一方的修改都不会被覆盖。
              </span>
            </>
          ) : (
            <>
              <Tag color="processing">离线批次进行中 · {batch.name}</Tag>
              <span>
                本机待同步 {pending} 项 · 已同步 {synced} 项；本页显示上一个确认版本（确认于 {confirmedAt}），逐项合并后更新。
              </span>
            </>
          )}
        </Space>
      }
    />
  )
}
