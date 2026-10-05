import { useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Steps,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ApiOutlined,
  CheckCircleOutlined,
  CloudSyncOutlined,
  DisconnectOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SaveOutlined,
  StopOutlined,
  ThunderboltOutlined,
  WifiOutlined,
} from '@ant-design/icons'
import { useIssues } from '../api/useIssues'
import { simulateRemoteEdits } from '../api/client'
import { useWorkspaceStore, diffChangedFields } from '../store/useWorkspaceStore'
import { useOnline } from '../lib/useOnline'
import { setSimulatedOffline } from '../lib/network'
import type { EntrySyncState, Issue, OfflineEntry, RetestField, RetestResult } from '../api/types'
import ConflictPanel from '../components/ConflictPanel'

const RETESTABLE: Issue['status'][] = ['待复测', '已退回']

const stateColor: Record<EntrySyncState, string> = {
  待提交: 'default',
  同步失败: 'warning',
  冲突待裁决: 'error',
  已同步: 'success',
}

type Decision = Partial<Record<RetestField, 'local' | 'remote'>>

export default function RetestPage() {
  useIssues()
  const online = useOnline()
  const issues = useWorkspaceStore((state) => state.issues)
  const batch = useWorkspaceStore((state) => state.batch)
  const startBatch = useWorkspaceStore((state) => state.startBatch)
  const saveEntry = useWorkspaceStore((state) => state.saveEntry)
  const removeEntry = useWorkspaceStore((state) => state.removeEntry)
  const syncBatch = useWorkspaceStore((state) => state.syncBatch)
  const resolveConflict = useWorkspaceStore((state) => state.resolveConflict)
  const abortBatch = useWorkspaceStore((state) => state.abortBatch)
  const archiveBatch = useWorkspaceStore((state) => state.archiveBatch)

  const [createOpen, setCreateOpen] = useState(false)
  const [createForm] = Form.useForm()
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])

  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [entryForm] = Form.useForm()
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [resolvingKey, setResolvingKey] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [simulating, setSimulating] = useState(false)

  const retestable = useMemo(() => issues.filter((item) => RETESTABLE.includes(item.status)), [issues])

  const counts = useMemo(() => {
    if (!batch) return { pending: 0, failed: 0, conflict: 0, synced: 0, saved: 0 }
    const by = (state: EntrySyncState) => batch.entries.filter((entry) => entry.syncState === state).length
    return { pending: by('待提交'), failed: by('同步失败'), conflict: by('冲突待裁决'), synced: by('已同步'), saved: batch.entries.length }
  }, [batch])

  const allSynced = Boolean(batch && batch.keys.every((key) => batch.entries.find((entry) => entry.issueKey === key)?.syncState === '已同步'))
  const remaining = counts.pending + counts.failed
  const activeIssue = activeKey ? issues.find((item) => item.key === activeKey) ?? null : null
  const activeEntry = batch?.entries.find((entry) => entry.issueKey === activeKey) ?? null

  const openCreate = () => {
    setSelectedKeys(retestable.map((item) => item.key))
    createForm.setFieldsValue({
      name: `会议室离线复测 ${new Date().toLocaleDateString('zh-CN')}`,
      room: '',
      device: navigator.userAgent.includes('Mac') ? 'MacBook Pro' : '',
      actor: '本机复测员',
    })
    setCreateOpen(true)
  }

  const confirmCreate = async () => {
    const values = await createForm.validateFields()
    if (!selectedKeys.length) {
      message.warning('请至少选择一个待复测问题')
      return
    }
    startBatch({ name: values.name, room: values.room, device: values.device, actor: values.actor, keys: selectedKeys })
    setCreateOpen(false)
    setActiveKey(selectedKeys[0])
    message.success(`离线批次已开始：${values.name}，数据仅保存在本机`)
  }

  const loadEntryForm = (issue: Issue, entry: OfflineEntry | null) => {
    if (entry) {
      entryForm.setFieldsValue({ result: entry.result, environment: entry.environment, evidence: entry.evidence, note: entry.note })
    } else {
      entryForm.setFieldsValue({
        result: '已通过' as RetestResult,
        environment: issue.retestEnv ?? '',
        evidence: '',
        note: '',
      })
    }
  }

  const saveLocal = async () => {
    if (!activeKey || !batch) return
    const values = await entryForm.validateFields()
    const baseIssue = batch.baseSnapshot[activeKey]
    // 与上一个确认版本逐项比较，只提交本人真正改过的字段
    const changedFields = baseIssue ? diffChangedFields(values, baseIssue) : (['status', 'retestEnv', 'retestEvidence', 'retestNote'] as RetestField[])
    if (changedFields.length === 0) {
      message.info('与确认基线相比没有任何改动，无需保存本机记录')
      return
    }
    saveEntry(activeKey, {
      result: values.result,
      environment: values.environment,
      evidence: values.evidence,
      note: values.note,
      changedFields,
    })
    message.success(
      online
        ? `已记录到本机批次（仅 ${changedFields.length} 个本人改过的字段将被提交），待逐项合并`
        : `断网中：结论已保存在本机（仅 ${changedFields.length} 个字段），网络恢复后合并`,
    )
  }

  const doSync = async () => {
    if (!online) {
      message.warning('仍处于离线状态，无法合并；记录已安全保留在本机')
      return
    }
    setSyncing(true)
    try {
      const summary = await syncBatch()
      const after = useWorkspaceStore.getState().batch
      const conflictNow = after?.entries.some((entry) => entry.syncState === '冲突待裁决')
      const failedNow = after?.entries.some((entry) => entry.syncState === '同步失败')
      if (conflictNow) message.warning('部分项与另一端冲突，已挂起等待逐项裁决（未覆盖任何一方）')
      else if (failedNow) message.warning('同步中途失败，已完成的项不会重做，可从剩余项继续')
      else if (summary.autoMerged.length || summary.deduped.length) message.success({
        content: `剩余项已全部逐项合并${summary.autoMerged.length ? `；自动并入另一端的远端变更：${summary.autoMerged.join('，')}` : ''}${summary.deduped.length ? `；${summary.deduped.join('、')} 命中幂等去重，未产生重复记录` : ''}`,
        duration: 6,
      })
      else message.success('剩余项已全部逐项合并')
    } finally {
      setSyncing(false)
    }
  }

  const simulateRemote = async () => {
    setSimulating(true)
    try {
      const { touched } = await simulateRemoteEdits()
      message.info(`已模拟断网期间另一端的并发修改：${touched.join('、') || '无（变更已存在）'}。恢复网络并合并时将出现差异或冲突`)
    } finally {
      setSimulating(false)
    }
  }

  const doResolve = async (issueKey: string) => {
    setResolvingKey(issueKey)
    try {
      await resolveConflict(issueKey, decisions[issueKey] ?? {})
      message.success(`${issueKey} 已按裁决字段合并，确认版本已更新`)
    } catch {
      message.error('裁决提交失败，该项保持挂起，请重试')
    } finally {
      setResolvingKey(null)
    }
  }

  /* ---------------- 无活动批次：开始 / 恢复 ---------------- */

  if (!batch) {
    return (
      <section className="page">
        <div className="page-head">
          <div>
            <p className="eyebrow">RETEST / 复测工作台</p>
            <h1>可恢复的离线复测批次</h1>
            <p className="muted">断网时照常记录结论、复测环境、证据与备注；数据留在本机，恢复后逐项合并，只提交本人改过的字段。</p>
          </div>
          <Tag color={online ? 'success' : 'error'} icon={online ? <WifiOutlined /> : <DisconnectOutlined />}>
            {online ? '网络正常' : '当前离线（也可照常复测）'}
          </Tag>
        </div>

        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="复测规则" description="键盘问题必须覆盖 Tab、Shift+Tab、Esc 和焦点返回；屏幕阅读器问题需保留截图、录屏或播报日志链接。同一问题重复保存只保留一条；同步中断后已完成的项不会重做。" />

        <div className="panel empty-batch">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" size={4}>
                <Typography.Text strong>当前没有进行中的离线复测批次</Typography.Text>
                <span className="muted">开始后将冻结当前台账为确认基线；本机记录与批次状态自动持久化，刷新、断网、中途失败都可恢复。</span>
              </Space>
            }
          >
            <Button type="primary" size="large" icon={<PlayCircleOutlined />} onClick={openCreate} disabled={!retestable.length}>
              开始离线复测批次（{retestable.length} 项待复测）
            </Button>
          </Empty>
        </div>

        <Modal
          title="开始离线复测批次"
          open={createOpen}
          onCancel={() => setCreateOpen(false)}
          onOk={confirmCreate}
          okText="开始批次并冻结确认版本"
          cancelText="取消"
          width={680}
        >
          <Form form={createForm} layout="vertical" style={{ marginTop: 12 }}>
            <Form.Item name="name" label="批次名称" rules={[{ required: true, message: '请填写批次名称' }]}>
              <Input placeholder="例如：10-05 会议室无障碍复测" />
            </Form.Item>
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="room" label="会议室" rules={[{ required: true, message: '请填写会议室' }]} style={{ flex: 1 }}>
                <Input placeholder="例如：3 号会议室" />
              </Form.Item>
              <Form.Item name="device" label="复测设备" rules={[{ required: true, message: '请填写复测设备' }]} style={{ flex: 1 }}>
                <Input placeholder="例如：MacBook Pro / NVDA 测试机" />
              </Form.Item>
              <Form.Item name="actor" label="复测人" rules={[{ required: true, message: '请填写复测人' }]} style={{ flex: 1 }}>
                <Input placeholder="本人姓名" />
              </Form.Item>
            </Space>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              纳入批次的问题将以当前台账为确认基线；批次结束前，问题台账 / 版本差异 / 整改报告保持该确认版本。
            </Typography.Paragraph>
            <Table
              size="small"
              rowKey="key"
              pagination={false}
              scroll={{ y: 260 }}
              dataSource={retestable}
              columns={[
                { title: '编号', dataIndex: 'key', width: 110 },
                { title: '问题', dataIndex: 'title' },
                { title: '状态', dataIndex: 'status', width: 90, render: (value: string) => <Tag color="orange">{value}</Tag> },
              ]}
              rowSelection={{
                selectedRowKeys: selectedKeys,
                onChange: (keys) => setSelectedKeys(keys as string[]),
              }}
            />
          </Form>
        </Modal>
      </section>
    )
  }

  /* ---------------- 活动批次 ---------------- */

  const queue: Array<Issue & { entry: OfflineEntry | null }> = batch.keys
    .map((key) => {
      const issue = issues.find((item) => item.key === key)
      const entry = batch.entries.find((item) => item.issueKey === key) ?? null
      return issue ? { ...issue, entry } : null
    })
    .filter((item): item is Issue & { entry: OfflineEntry | null } => Boolean(item))

  const columns: ColumnsType<Issue & { entry: OfflineEntry | null }> = [
    {
      title: '问题',
      dataIndex: 'key',
      render: (_, record) => (
        <div>
          <Typography.Text strong>{record.key}</Typography.Text>
          <div>{record.title}</div>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>{record.site} · {record.version}</Typography.Text>
        </div>
      ),
    },
    { title: '确认基线状态', dataIndex: 'status', width: 110, render: (value: string) => <Tag>{value}</Tag> },
    {
      title: '本机结论',
      width: 110,
      render: (_, record) => (record.entry ? <Tag color="blue">{record.entry.result}</Tag> : <span className="muted">未记录</span>),
    },
    {
      title: '同步状态',
      width: 130,
      render: (_, record) =>
        record.entry ? (
          <Badge status={record.entry.syncState === '已同步' ? 'success' : record.entry.syncState === '冲突待裁决' ? 'error' : record.entry.syncState === '同步失败' ? 'warning' : 'default'} text={record.entry.syncState} />
        ) : (
          <span className="muted">—</span>
        ),
    },
  ]

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">OFFLINE BATCH / 离线复测批次</p>
          <h1>{batch.name}</h1>
          <p className="muted">开始于 {batch.createdAt} · {batch.room || '会议室未填'} · {batch.device || '设备未填'} · 复测人 {batch.actor}</p>
        </div>
        <Space wrap>
          <Tag color={online ? 'success' : 'error'} icon={online ? <WifiOutlined /> : <DisconnectOutlined />}>{online ? '网络正常' : '离线记录中'}</Tag>
          <Button icon={<ThunderboltOutlined />} loading={simulating} onClick={simulateRemote}>模拟另一端并发修改</Button>
          <Button
            icon={online ? <ApiOutlined /> : <DisconnectOutlined />}
            onClick={() => setSimulatedOffline(online)}
            danger={online}
          >
            {online ? '模拟断网' : '模拟恢复网络'}
          </Button>
          <Popconfirm title="放弃本批次？" description="本机尚未合并的复测记录将被删除，且不影响服务器数据。" onConfirm={abortBatch}>
            <Button icon={<StopOutlined />}>放弃批次</Button>
          </Popconfirm>
        </Space>
      </div>

      {!online && <Alert type="error" showIcon icon={<DisconnectOutlined />} style={{ marginBottom: 12 }} message={`网络不可用：复测照常进行，${counts.saved} 条记录只保存在本机，不会发送；恢复网络后点击"逐项合并剩余项"。`} />}

      <div className="panel batch-progress">
        <Steps
          size="small"
          current={allSynced ? 3 : counts.conflict ? 2 : remaining ? 1 : 0}
          status={counts.conflict ? 'error' : allSynced ? 'finish' : 'process'}
          items={[
            { title: `本机记录 ${counts.saved}/${batch.keys.length}` },
            { title: `待合并剩余 ${remaining}` },
            { title: counts.conflict ? `冲突待裁决 ${counts.conflict}` : '冲突 0' },
            { title: `已同步 ${counts.synced}` },
          ]}
        />
        <Space wrap className="batch-actions">
          <Button
            type="primary"
            icon={<CloudSyncOutlined />}
            disabled={!online || remaining === 0 || syncing}
            loading={syncing}
            onClick={doSync}
          >
            {online ? `逐项合并剩余项（${remaining}）` : '离线中，等待恢复'}
          </Button>
          {counts.failed > 0 && <Tag color="warning" icon={<ReloadOutlined />}>中途失败：再次点击将从第一个未完成项恢复，已同步项不重做</Tag>}
          {counts.conflict > 0 && <Tag color="error">有 {counts.conflict} 项冲突需先在下方裁决</Tag>}
          {allSynced && (
            <>
              <Tag color="success" icon={<CheckCircleOutlined />}>全部 {batch.keys.length} 项已逐项合并，重复记录已去重</Tag>
              <Button type="primary" ghost onClick={archiveBatch}>归档并结束批次</Button>
            </>
          )}
        </Space>
      </div>

      <ConflictPanel batch={batch} decisions={decisions} resolvingKey={resolvingKey} onDecide={(key, decision) => setDecisions((current) => ({ ...current, [key]: decision }))} onResolve={doResolve} />

      <div className="review-grid">
        <div className="panel">
          <div className="panel-head"><h3>本批复测队列（{batch.keys.length}）</h3><span className="muted">点击逐项复测</span></div>
          <Table
            rowKey="key"
            columns={columns}
            dataSource={queue}
            pagination={false}
            rowClassName={(record) => (record.key === activeKey ? 'ant-table-row-selected' : '')}
            onRow={(record) => ({
              onClick: () => {
                setActiveKey(record.key)
                loadEntryForm(record, record.entry)
              },
            })}
            scroll={{ x: 640 }}
          />
        </div>

        <div className="panel review-box">
          {!activeIssue && <Typography.Text type="secondary">请从左侧选择复测项</Typography.Text>}
          {activeIssue && (
            <>
              <Space wrap style={{ marginBottom: 8 }}>
                <Typography.Title level={4} style={{ margin: 0 }}>{activeIssue.key}</Typography.Title>
                {activeEntry && <Tag color={stateColor[activeEntry.syncState]}>{activeEntry.syncState}</Tag>}
              </Space>
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="问题">{activeIssue.title}</Descriptions.Item>
                <Descriptions.Item label="根因（确认基线）">{activeIssue.rootCause}</Descriptions.Item>
                <Descriptions.Item label="修复说明">{activeIssue.fixNote ?? '未提交'}</Descriptions.Item>
                <Descriptions.Item label="开发登记环境">{activeIssue.retestEnv ?? '待开发提交'}</Descriptions.Item>
              </Descriptions>

              {activeEntry?.syncState === '已同步' ? (
                <Alert
                  style={{ marginTop: 16 }}
                  type="success"
                  showIcon
                  message={`该机记录已于 ${activeEntry.appliedAt} 合并到共享台账（${activeEntry.attempts > 1 ? '经历过重试，服务器按记录编号去重' : '提交成功'}）`}
                  description="已同步项不允许再次修改或重做；如结论需要更正，请在共享台账中发起新一轮复测。"
                />
              ) : activeEntry?.syncState === '冲突待裁决' ? (
                <Alert
                  style={{ marginTop: 16 }}
                  type="error"
                  showIcon
                  message="该项与另一端冲突，本机编辑已锁定"
                  description="请在上方冲突裁决中心逐字段选择保留本机或采用远端；裁决完成前不会覆盖任何一方版本。"
                />
              ) : (
                <Form form={entryForm} layout="vertical" style={{ marginTop: 16 }} initialValues={{ result: '已通过' }}>
                  <Form.Item name="result" label="复测结论" rules={[{ required: true, message: '请选择结论' }]}>
                    <Radio.Group>
                      <Radio.Button value="已通过">通过</Radio.Button>
                      <Radio.Button value="已退回">退回</Radio.Button>
                      <Radio.Button value="不适用">不适用</Radio.Button>
                    </Radio.Group>
                  </Form.Item>
                  <Form.Item name="environment" label="本次复测环境" rules={[{ required: true, message: '请记录浏览器 / 辅助技术 / 版本号' }]}>
                    <Input placeholder="浏览器 / 辅助技术 / 版本号" />
                  </Form.Item>
                  <Form.Item name="evidence" label="复测证据" rules={[{ required: true, message: '请提供截图、录屏或播报日志位置' }]}>
                    <Input placeholder="截图 / 录屏 / 播报日志链接或本机文件名" />
                  </Form.Item>
                  <Form.Item name="note" label="复测备注" rules={[{ required: true, message: '请填写可验证的复测记录' }]}>
                    <Input.TextArea rows={4} placeholder="记录实际操作步骤、观察结果与证据位置" />
                  </Form.Item>
                  <Space style={{ display: 'flex' }}>
                    <Button type="primary" icon={<SaveOutlined />} onClick={saveLocal} block>
                      {online ? '保存到本机批次' : '断网保存（仅本机）'}
                    </Button>
                    {activeEntry && (
                      <Popconfirm title="删除这条本机记录？" onConfirm={() => { removeEntry(activeIssue.key); message.success('本机记录已删除') }}>
                        <Button danger ghost>删除</Button>
                      </Popconfirm>
                    )}
                  </Space>
                  {activeEntry && (
                    <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
                      最近本机保存 {activeEntry.savedAt}
                      {activeEntry.lastError ? ` · ${activeEntry.lastError}` : ''}
                      {activeEntry.syncState === '同步失败' ? ' · 恢复网络后将从该项继续' : ''}
                    </Typography.Text>
                  )}
                </Form>
              )}

              <Typography.Title level={5} style={{ marginTop: 18 }}>确认基线中的历史复测</Typography.Title>
              {activeIssue.retestRecords.length === 0 && <Typography.Text type="secondary">暂无历史记录</Typography.Text>}
              {activeIssue.retestRecords.map((record) => (
                <div className="timeline-item" key={record.id}>
                  <Tag color={record.result === '已通过' || record.result === '通过' ? 'success' : record.result === '已退回' || record.result === '退回' ? 'error' : 'default'}>{record.result}</Tag>
                  <Typography.Text strong>{record.actor}</Typography.Text>
                  <div>{record.note}</div>
                  {record.environment && <div className="muted" style={{ fontSize: 11 }}>环境：{record.environment}</div>}
                  {record.evidence && <div className="muted" style={{ fontSize: 11 }}>证据：{record.evidence}</div>}
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>{record.at}</Typography.Text>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
