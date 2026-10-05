import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { NavLink, Outlet } from 'react-router-dom'
import { Button, Drawer, Layout, Menu, Space, Tag, Typography } from 'antd'
import {
  AppstoreOutlined,
  AuditOutlined,
  BarsOutlined,
  CloudSyncOutlined,
  DiffOutlined,
  DisconnectOutlined,
  FileDoneOutlined,
  MenuOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import ConflictNotice from './ConflictNotice'
import { useNetwork } from '../store/useNetworkStore'
import { useRetestStore } from '../store/useRetestStore'

const items = [
  { key: '/', icon: <AppstoreOutlined />, label: <NavLink to="/">整改总览</NavLink> },
  { key: '/issues', icon: <BarsOutlined />, label: <NavLink to="/issues">问题台账</NavLink> },
  { key: '/retest', icon: <AuditOutlined />, label: <NavLink to="/retest">复测工作台</NavLink> },
  { key: '/versions', icon: <DiffOutlined />, label: <NavLink to="/versions">版本差异</NavLink> },
  { key: '/report', icon: <FileDoneOutlined />, label: <NavLink to="/report">整改报告</NavLink> },
]

export default function AppLayout() {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const { effectiveOnline } = useNetwork()
  const syncing = useRetestStore((state) => state.syncing)
  const syncAll = useRetestStore((state) => state.syncAll)
  const pendingCount = useRetestStore((state) => state.entries.filter((entry) => ['pending', 'failed'].includes(entry.status)).length)
  const conflictCount = useRetestStore((state) => state.entries.filter((entry) => entry.status === 'conflict').length)
  const prevOnline = useRef(effectiveOnline)

  // 断网记录恢复后自动逐项合并；已同步项不重做
  useEffect(() => {
    if (effectiveOnline && !prevOnline.current) {
      const pending = useRetestStore.getState().entries.filter((entry) => ['pending', 'failed'].includes(entry.status))
      if (pending.length) {
        syncAll().then(() => queryClient.invalidateQueries({ queryKey: ['issues'] }))
      }
    }
    prevOnline.current = effectiveOnline
  }, [effectiveOnline, syncAll, queryClient])

  const runSync = async () => {
    await syncAll()
    queryClient.invalidateQueries({ queryKey: ['issues'] })
  }

  const sidebar = (
    <div className="sidebar-inner">
      <div className="brand">
        <div className="brand-mark"><AuditOutlined /></div>
        <div><strong>无障碍整改中心</strong><small>企业数字体验治理</small></div>
      </div>
      <Menu mode="inline" theme="dark" items={items} selectedKeys={[location.pathname]} onClick={() => setOpen(false)} />
      <div className="sync-card">
        <Space size={6}>
          {effectiveOnline ? <Tag color="success" icon={<CloudSyncOutlined />}>在线</Tag> : <Tag color="error" icon={<DisconnectOutlined />}>离线</Tag>}
          <strong>{effectiveOnline ? '网络正常' : '离线模式'}</strong>
        </Space>
        <span>
          {pendingCount ? `${pendingCount} 项待同步` : '无待同步记录'}
          {conflictCount ? ` · ${conflictCount} 项冲突` : ''}
        </span>
        <Button size="small" type="primary" ghost icon={<SyncOutlined />} loading={syncing} disabled={!effectiveOnline || !pendingCount} onClick={runSync}>
          同步复测记录
        </Button>
      </div>
    </div>
  )

  return (
    <Layout className="shell">
      <Layout.Sider width={242} className="desktop-sider">{sidebar}</Layout.Sider>
      <Drawer placement="left" open={open} onClose={() => setOpen(false)} width={250} styles={{ body: { padding: 0, background: '#15313d' } }}>{sidebar}</Drawer>
      <Layout>
        <Layout.Header className="mobile-header">
          <Button type="text" icon={<MenuOutlined />} onClick={() => setOpen(true)} />
          <Typography.Text strong>无障碍整改中心</Typography.Text>
          <Space />
        </Layout.Header>
        <Layout.Content>
          <div style={{ padding: '16px 22px 0' }}>
            <ConflictNotice />
          </div>
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
