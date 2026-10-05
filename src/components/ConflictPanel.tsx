import { Alert, Button, Card, Radio, Space, Table, Tag, Typography } from 'antd'
import { LockOutlined, MergeOutlined } from '@ant-design/icons'
import { RETEST_FIELD_LABEL, type ConflictResponse, type OfflineBatch, type RetestField } from '../api/types'
import { getFieldValue } from '../lib/fields'
import { selectRemoteOnlyChanges } from '../store/useWorkspaceStore'

type Decision = Partial<Record<RetestField, 'local' | 'remote'>>

function localIssueFor(batch: OfflineBatch, issueKey: string) {
  const entry = batch.entries.find((item) => item.issueKey === issueKey)
  const base = batch.baseSnapshot[issueKey]
  if (!entry || !base) return base
  return {
    ...base,
    status: entry.changedFields.includes('status') ? entry.result : base.status,
    retestEnv: entry.changedFields.includes('retestEnv') ? entry.environment : base.retestEnv,
    retestEvidence: entry.changedFields.includes('retestEvidence') ? entry.evidence : base.retestEvidence,
    retestRecords: entry.changedFields.includes('retestNote')
      ? [...base.retestRecords, { id: entry.recordId, actor: batch.actor, result: entry.result, note: entry.note, at: entry.savedAt, environment: entry.environment, evidence: entry.evidence }]
      : base.retestRecords,
  }
}

export default function ConflictPanel({
  batch,
  decisions,
  resolvingKey,
  onDecide,
  onResolve,
}: {
  batch: OfflineBatch
  decisions: Record<string, Decision>
  resolvingKey?: string | null
  onDecide: (issueKey: string, decision: Decision) => void
  onResolve: (issueKey: string) => void
}) {
  const conflicts = batch.entries.filter((entry) => entry.syncState === '冲突待裁决' && entry.conflict)
  if (!conflicts.length) return null

  return (
    <div className="panel conflict-panel">
      <div className="panel-head">
        <h3><LockOutlined /> 冲突裁决中心（{conflicts.length}）</h3>
        <Tag color="error">裁决完成前三处页面保持上一个确认版本，不会覆盖任何一方</Tag>
      </div>
      <div className="conflict-list">
        {conflicts.map((entry) => {
          const conflict = entry.conflict as ConflictResponse
          const local = localIssueFor(batch, entry.issueKey)
          const remote = conflict.current
          const autoMerged = selectRemoteOnlyChanges(entry)
          const decision = decisions[entry.issueKey] ?? {}
          const decidedAll = conflict.conflictFields.every((field) => decision[field])
          return (
            <Card
              key={entry.issueKey}
              size="small"
              className="conflict-card"
              title={
                <Space wrap>
                  <Typography.Text strong>{entry.issueKey}</Typography.Text>
                  <Tag color="red">{conflict.conflictFields.map((field) => RETEST_FIELD_LABEL[field]).join('、')} 双方都改过</Tag>
                  <span className="muted">基线版本时间：{batch.baseRevisions[entry.issueKey]?.status.at}</span>
                </Space>
              }
              extra={
                <Button
                  type="primary"
                  danger
                  icon={<MergeOutlined />}
                  loading={resolvingKey === entry.issueKey}
                  disabled={!decidedAll || resolvingKey === entry.issueKey}
                  onClick={() => onResolve(entry.issueKey)}
                >
                  {decidedAll ? '按字段裁决并合并该项' : '请逐字段选择'}
                </Button>
              }
            >
              <Table
                rowKey="field"
                size="small"
                pagination={false}
                scroll={{ x: 720 }}
                dataSource={conflict.conflictFields.map((field) => ({ field }))}
                columns={[
                  {
                    title: '冲突字段',
                    dataIndex: 'field',
                    width: 150,
                    render: (field: RetestField) => <Typography.Text strong>{RETEST_FIELD_LABEL[field]}</Typography.Text>,
                  },
                  {
                    title: '上一个确认版本（基线）',
                    width: 210,
                    render: (_, row) => <Typography.Text type="secondary">{getFieldValue(batch.baseSnapshot[entry.issueKey], row.field)}</Typography.Text>,
                  },
                  {
                    title: '本机离线记录',
                    width: 210,
                    render: (_, row) => (
                      <div>
                        <Tag color="blue">本机 · {batch.actor}</Tag>
                        <div>{getFieldValue(local, row.field)}</div>
                      </div>
                    ),
                  },
                  {
                    title: '另一端最新版本',
                    width: 210,
                    render: (_, row) => (
                      <div>
                        <Tag color="orange">{remote.revision[row.field].actor}</Tag>
                        <div>{getFieldValue(remote, row.field)}</div>
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>{remote.revision[row.field].at}</Typography.Text>
                      </div>
                    ),
                  },
                  {
                    title: '裁决（必选）',
                    width: 240,
                    render: (_, row) => (
                      <Radio.Group
                        optionType="button"
                        size="small"
                        value={decision[row.field]}
                        onChange={(event) => onDecide(entry.issueKey, { ...decision, [row.field]: event.target.value })}
                        options={[
                          { value: 'local', label: '保留本机' },
                          { value: 'remote', label: '采用远端' },
                        ]}
                      />
                    ),
                  },
                ]}
              />

              {autoMerged.length > 0 && (
                <Alert
                  style={{ marginTop: 10 }}
                  type="warning"
                  showIcon
                  message={`以下字段只在另一端被修改，本机未改动，将自动并入远端版本（不覆盖本人复测）：${autoMerged
                    .map((change) => `${RETEST_FIELD_LABEL[change.field]}（${change.actor} · ${change.at}）`)
                    .join('；')}`}
                />
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}
