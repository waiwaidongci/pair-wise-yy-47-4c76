import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  CloudSyncOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  PlusOutlined,
  SyncOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import { useIssues } from '../api/useIssues'
import { setNetworkOffline, simulateChange } from '../api/retestApi'
import { useWorkspaceStore } from '../store/useWorkspaceStore'
import { useRetestStore } from '../store/useRetestStore'
import { useNetworkStore } from '../store/useNetworkStore'
import type { ConflictField, Issue, OutboxEntry, RetestResult } from '../api/types'

const resultColor: Record<string, string> = { 已通过: 'success', 已退回: 'error', 不适用: 'default' }

const statusMeta: Record<OutboxEntry['status'], { text: string; color: string }> = {
  pending: { text: '待同步', color: 'default' },
  syncing: { text: '同步中', color: 'processing' },
  synced: { text: '已同步', color: 'success' },
  conflict: { text: '冲突', color: 'error' },
  failed: { text: '失败', color: 'warning' },
}

export default function RetestPage() {
  useIssues()
  const queryClient = useQueryClient()
  const issues = useWorkspaceStore((state) => state.issues)
  const entries = useRetestStore((state) => state.entries)
  const batches = useRetestStore((state) => state.batches)
  const activeBatchId = useRetestStore((state) => state.activeBatchId)
  const syncing = useRetestStore((state) => state.syncing)
  const addEntry = useRetestStore((state) => state.addEntry)
  const removeEntry = useRetestStore((state) => state.removeEntry)
  const syncAll = useRetestStore((state) => state.syncAll)
  const syncOne = useRetestStore((state) => state.syncOne)
  const resolveStore = useRetestStore((state) => state.resolve)
  const createBatch = useRetestStore((state) => state.createBatch)
  const setActiveBatch = useRetestStore((state) => state.setActiveBatch)
  const effectiveOnline = useNetworkStore((state) => state.effectiveOnline)
  const manualOffline = useNetworkStore((state) => state.manualOffline)
  const setManualOffline = useNetworkStore((state) => state.setManualOffline)

  const queue = issues.filter((item) => ['待复测', '已退回'].includes(item.status))
  const [active, setActive] = useState<Issue | null>(queue[0] ?? null)
  const [form] = Form.useForm()
  const [conflictEntry, setConflictEntry] = useState<OutboxEntry | null>(null)
  const [choices, setChoices] = useState<Record<string, 'ours' | 'theirs'>>({})

  const activeBatch = batches.find((batch) => batch.id === activeBatchId) ?? null
  const batchEntries = entries.filter((entry) => entry.batchId === activeBatchId)
  const syncedCount = batchEntries.filter((entry) => entry.status === 'synced').length
  const pendingCount = entries.filter((entry) => ['pending', 'failed'].includes(entry.status)).length
  const conflictCount = entries.filter((entry) => entry.status === 'conflict').length

  const openEntryByKey = useMemo(() => {
    const map = new Map<string, OutboxEntry>()
    entries.forEach((entry) => {
      if (['pending', 'failed', 'conflict'].includes(entry.status)) map.set(entry.issueKey, entry)
    })
    return map
  }, [entries])

  const refreshIssues = () => queryClient.invalidateQueries({ queryKey: ['issues'] })

  const runSync = async () => {
    const result = await syncAll()
    await refreshIssues()
    if (result.conflicts) {
      const first = useRetestStore.getState().entries.find((entry) => entry.status === 'conflict')
      if (first) openConflict(first)
    } else if (result.failed) {
      message.warning(`同步中途失败：${result.failed} 项未完成，已从剩余项恢复，已同步项不重做`)
    } else if (!result.synced) {
      message.info('没有待同步的离线记录')
    } else {
      message.success(`已逐项合并 ${result.synced} 项复测记录`)
    }
  }

  const submit = async (values: { result: RetestResult; note: string; environment: string; evidence?: string }) => {
    if (!active) return
    addEntry(active, { result: values.result, note: values.note, environment: values.environment, evidence: values.evidence ?? '' })
    form.resetFields()
    if (effectiveOnline) {
      await runSync()
    } else {
      message.success('复测结论、环境、证据与备注已存入本机离线批次，联网后自动同步')
    }
  }

  const toggleOffline = async (checked: boolean) => {
    setManualOffline(checked)
    try {
      await setNetworkOffline(checked)
      if (!checked) runSync()
    } catch {
      message.error('网络切换失败，请重试')
    }
  }

  const openConflict = (entry: OutboxEntry) => {
    setConflictEntry(entry)
    const next: Record<string, 'ours' | 'theirs'> = {}
    entry.conflictFields?.forEach((field) => {
      next[field.field] = field.field === 'status' ? 'ours' : 'theirs'
    })
    setChoices(next)
  }

  const submitConflict = async (mode: 'ours' | 'theirs' | 'custom') => {
    if (!conflictEntry) return
    const finalChoices: Record<string, 'ours' | 'theirs'> =
      mode === 'ours'
        ? { status: 'ours', rootCause: 'theirs' }
        : mode === 'theirs'
          ? { status: 'theirs', rootCause: 'theirs' }
          : choices
    await resolveStore(conflictEntry.id, mode !== 'theirs', finalChoices)
    await refreshIssues()
    const next = useRetestStore.getState().entries.find((entry) => entry.status === 'conflict')
    if (next) {
      openConflict(next)
    } else {
      setConflictEntry(null)
      message.success('冲突已处理，问题台账更新为确认版本')
    }
  }

  const devMutate = async () => {
    try {
      await simulateChange(active?.key)
      await refreshIssues()
      message.info('已模拟另一端（开发 / 另一名复测员）并发修改当前问题，可用于演示冲突')
    } catch {
      message.error('模拟失败')
    }
  }

  const queueColumns: ColumnsType<Issue> = [
    {
      title: '问题',
      dataIndex: 'key',
      render: (_, record) => (
        <div>
          <Typography.Text strong>{record.key}</Typography.Text>
          <div>{record.title}</div>
          {openEntryByKey.has(record.key) && (
            <Tag color={statusMeta[openEntryByKey.get(record.key)!.status].color} style={{ marginTop: 4 }}>
              已有离线{statusMeta[openEntryByKey.get(record.key)!.status].text}记录
            </Tag>
          )}
        </div>
      ),
    },
    { title: '修复说明', dataIndex: 'fixNote', width: 220, render: (value) => value ?? '未提交' },
    { title: '环境', dataIndex: 'retestEnv', width: 170, render: (value) => value ?? '待开发提交' },
    { title: '状态', dataIndex: 'status', width: 86, render: (value) => <Tag color={value === '已退回' ? 'error' : 'orange'}>{value}</Tag> },
  ]

  const entryColumns: ColumnsType<OutboxEntry> = [
    {
      title: '问题',
      dataIndex: 'issueKey',
      width: 150,
      render: (_, record) => (
        <div>
          <Typography.Text strong>{record.issueKey}</Typography.Text>
          <div style={{ fontSize: 12, color: '#74818a' }}>{record.issueTitle}</div>
        </div>
      ),
    },
    { title: '结论', dataIndex: ['patch', 'result'], width: 80, render: (value: RetestResult) => <Tag color={resultColor[value]}>{value}</Tag> },
    { title: '复测环境', dataIndex: ['patch', 'environment'], width: 180 },
    {
      title: '备注 / 证据',
      dataIndex: ['patch', 'note'],
      render: (_, record) => (
        <div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{record.patch.note}</div>
          {record.patch.evidence && <Typography.Link href={record.patch.evidence} target="_blank" style={{ fontSize: 12 }}>{record.patch.evidence}</Typography.Link>}
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (value: OutboxEntry['status'], record) => (
        <Tooltip title={record.error ?? (value === 'conflict' ? '对方也修改了同一字段，需处理' : '')}>
          <Tag color={statusMeta[value].color} icon={value === 'conflict' ? <WarningOutlined /> : undefined}>
            {statusMeta[value].text}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: '操作',
      width: 170,
      render: (_, record) => (
        <Space size={4}>
          {record.status === 'conflict' && (
            <Button size="small" type="link" onClick={() => openConflict(record)}>
              处理冲突
            </Button>
          )}
          {['pending', 'failed'].includes(record.status) && (
            <Button size="small" type="link" icon={<SyncOutlined />} disabled={!effectiveOnline || syncing} onClick={() => syncOne(record.id).then(refreshIssues)}>
              重试
            </Button>
          )}
          {record.status !== 'syncing' && (
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => removeEntry(record.id)} />
          )}
        </Space>
      ),
    },
  ]

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">RETEST / 复测工作台</p>
          <h1>逐项验证修复结果</h1>
          <p className="muted">断网时结论、环境、证据与备注留在本机，联网后逐项合并，只提交本人改过的字段。</p>
        </div>
        <Space wrap>
          <Tag color={effectiveOnline ? 'success' : 'error'} icon={effectiveOnline ? <CloudSyncOutlined /> : <DisconnectOutlined />}>
            {effectiveOnline ? '在线' : '离线'}
          </Tag>
          <Tooltip title="演示用：手动断开网络，MSW 将拒绝所有请求">
            <Space size={6}>
              <Switch size="small" checked={manualOffline} onChange={toggleOffline} />
              <span className="muted" style={{ fontSize: 12 }}>模拟断网</span>
            </Space>
          </Tooltip>
          <Tooltip title="演示用：模拟开发或另一名复测员并发修改当前问题">
            <Button size="small" icon={<ThunderboltOutlined />} onClick={devMutate}>
              模拟对方修改
            </Button>
          </Tooltip>
        </Space>
      </div>

      {!effectiveOnline && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="当前离线：复测记录保存在本机浏览器"
          description="可照常逐项记录复测结论、环境、证据与备注。恢复网络后将自动逐项合并；已同步的项不会重做，中途失败从剩余项继续。"
        />
      )}

      <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
        <Space wrap size="large" style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space wrap>
            <span className="muted">当前批次</span>
            <Select
              size="small"
              style={{ width: 240 }}
              value={activeBatchId}
              onChange={setActiveBatch}
              options={batches.map((batch) => ({ value: batch.id, label: `${batch.name}（${batch.status === 'open' ? '进行中' : '已完成'}）` }))}
              placeholder="选择离线批次"
            />
            <Button size="small" icon={<PlusOutlined />} onClick={() => createBatch()}>
              新建批次
            </Button>
          </Space>
          <Space wrap size="large">
            <Statistic title="本批进度" value={syncedCount} suffix={`/ ${batchEntries.length || 0}`} />
            <Tag color={pendingCount ? 'warning' : 'default'}>待同步 {pendingCount}</Tag>
            <Tag color={conflictCount ? 'error' : 'default'}>冲突 {conflictCount}</Tag>
            <Button type="primary" icon={<SyncOutlined />} loading={syncing} disabled={!effectiveOnline || !pendingCount} onClick={runSync}>
              同步复测记录
            </Button>
          </Space>
        </Space>
      </div>

      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="复测规则" description="键盘问题必须覆盖 Tab、Shift+Tab、Esc 和焦点返回；屏幕阅读器问题需保留截图或播报日志。退回的问题不可无痕跳过。" />

      <div className="review-grid">
        <div className="panel">
          <div className="panel-head"><h3>复测队列</h3><span className="muted">点击选择问题</span></div>
          <Table rowKey="key" columns={queueColumns} dataSource={queue} pagination={false} rowClassName={(record) => record.key === active?.key ? 'ant-table-row-selected' : ''} onRow={(record) => ({ onClick: () => { setActive(record); form.resetFields() } })} scroll={{ x: 760 }} />
        </div>

        <div className="panel review-box">
          <Typography.Title level={4}>{active?.key ?? '暂无可复测项'}</Typography.Title>
          {active && (
            <>
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="问题">{active.title}</Descriptions.Item>
                <Descriptions.Item label="根因">{active.rootCause}</Descriptions.Item>
                <Descriptions.Item label="修复说明">{active.fixNote ?? '未提交'}</Descriptions.Item>
                <Descriptions.Item label="复测环境">{active.retestEnv ?? '待开发提交'}</Descriptions.Item>
              </Descriptions>
              <Form form={form} layout="vertical" style={{ marginTop: 18 }} onFinish={submit} initialValues={{ result: '已通过' }}>
                <Form.Item name="result" label="复测结论" rules={[{ required: true }]}>
                  <Radio.Group><Radio.Button value="已通过">通过</Radio.Button><Radio.Button value="已退回">退回</Radio.Button><Radio.Button value="不适用">不适用</Radio.Button></Radio.Group>
                </Form.Item>
                <Form.Item name="environment" label="本次复测环境" rules={[{ required: true }]}><Input placeholder="浏览器 / 辅助技术 / 版本号" /></Form.Item>
                <Form.Item name="evidence" label="证据链接 / 位置"><Input placeholder="录屏、截图或播报日志链接（选填）" /></Form.Item>
                <Form.Item name="note" label="复测记录" rules={[{ required: true, message: '请填写可验证的复测记录' }]}><Input.TextArea rows={4} placeholder="记录实际操作、结果与证据位置" /></Form.Item>
                <Button type="primary" htmlType="submit" block>{effectiveOnline ? '提交并同步' : '存入本机离线批次'}</Button>
              </Form>
              <Typography.Title level={5} style={{ marginTop: 20 }}>历史复测</Typography.Title>
              {active.retestRecords.length === 0 && <Typography.Text type="secondary">暂无历史记录</Typography.Text>}
              {active.retestRecords.map((record) => (
                <div className="timeline-item" key={record.id}>
                  <Tag color={record.result === '通过' ? 'success' : record.result === '退回' ? 'error' : 'default'}>{record.result}</Tag>
                  <Typography.Text strong>{record.actor}</Typography.Text>
                  <div>{record.note}</div>
                  {record.evidence && <Typography.Link href={record.evidence} target="_blank" style={{ fontSize: 12 }}>{record.evidence}</Typography.Link>}
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>{record.at}</Typography.Text>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <div className="panel-head">
          <h3>离线复测记录</h3>
          <span className="muted">仅保留本人修改字段 · 同一问题重复记录只保留一条</span>
        </div>
        <Table
          rowKey="id"
          columns={entryColumns}
          dataSource={entries}
          pagination={{ pageSize: 8, showTotal: (total) => `共 ${total} 条` }}
          scroll={{ x: 960 }}
          locale={{ emptyText: '暂无离线记录：断网时提交的复测会显示在这里' }}
        />
      </div>

      <Modal
        title={
          <Space>
            <WarningOutlined style={{ color: '#d48806' }} />
            <span>复测冲突：{conflictEntry?.issueKey}</span>
          </Space>
        }
        open={Boolean(conflictEntry)}
        onCancel={() => setConflictEntry(null)}
        width={720}
        footer={[
          <Button key="theirs" onClick={() => submitConflict('theirs')}>采用对方版本（丢弃我方记录）</Button>,
          <Button key="ours" type="primary" onClick={() => submitConflict('ours')}>采用我方复测结论</Button>,
          <Button key="custom" type="primary" ghost onClick={() => submitConflict('custom')}>按选择处理</Button>,
        ]}
      >
        {conflictEntry && (
          <>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="对方在你离线期间修改了同一问题，不能覆盖"
              description="请逐项核对双方版本与冲突字段。未处理完成前，问题台账、版本差异和整改报告继续显示上一个确认版本。"
            />
            <Descriptions size="small" column={1} bordered style={{ marginBottom: 12 }}>
              <Descriptions.Item label="问题">{conflictEntry.issueTitle}</Descriptions.Item>
              <Descriptions.Item label="我方复测环境">{conflictEntry.patch.environment}</Descriptions.Item>
              <Descriptions.Item label="我方复测记录"><span style={{ whiteSpace: 'pre-wrap' }}>{conflictEntry.patch.note}</span></Descriptions.Item>
            </Descriptions>
            {conflictEntry.conflictFields?.map((field: ConflictField) => (
              <div key={field.field} className="panel" style={{ padding: 12, marginBottom: 10 }}>
                <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                  <Typography.Text strong>{field.label}</Typography.Text>
                  <Radio.Group
                    size="small"
                    value={choices[field.field]}
                    onChange={(event) => setChoices({ ...choices, [field.field]: event.target.value })}
                    optionType="button"
                    buttonStyle="solid"
                  >
                    <Radio.Button value="ours">采用我方</Radio.Button>
                    <Radio.Button value="theirs">采用对方</Radio.Button>
                  </Radio.Group>
                </Space>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 10, fontSize: 12 }}>
                  <div><Typography.Text type="secondary">基线（录制时）</Typography.Text><div>{field.base}</div></div>
                  <div><Typography.Text type="secondary">我方版本</Typography.Text><div style={{ color: '#1d6570', fontWeight: 600 }}>{field.ours}</div></div>
                  <div><Typography.Text type="secondary">对方版本</Typography.Text><div style={{ color: '#b84f32', fontWeight: 600 }}>{field.theirs}</div></div>
                </div>
              </div>
            ))}
          </>
        )}
      </Modal>
    </section>
  )
}
