import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Badge, Button, Drawer, Layout, Menu, Space, Tag, Typography } from 'antd'
import {
  AppstoreOutlined,
  AuditOutlined,
  BarsOutlined,
  CloudSyncOutlined,
  DiffOutlined,
  DisconnectOutlined,
  FileDoneOutlined,
  MenuOutlined,
  WifiOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useOnline } from '../lib/useOnline'
import { setSimulatedOffline } from '../lib/network'
import { useWorkspaceStore } from '../store/useWorkspaceStore'

const items = [
  { key: '/', icon: <AppstoreOutlined />, label: <NavLink to="/">整改总览</NavLink> },
  { key: '/issues', icon: <BarsOutlined />, label: <NavLink to="/issues">问题台账</NavLink> },
  { key: '/retest', icon: <AuditOutlined />, label: <NavLink to="/retest">复测工作台</NavLink> },
  { key: '/versions', icon: <DiffOutlined />, label: <NavLink to="/versions">版本差异</NavLink> },
  { key: '/report', icon: <FileDoneOutlined />, label: <NavLink to="/report">整改报告</NavLink> },
]

export default function AppLayout() {
  const [open, setOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const online = useOnline()
  const batch = useWorkspaceStore((state) => state.batch)
  const lastSyncAt = useWorkspaceStore((state) => state.lastSyncAt)

  const pending = batch?.entries.filter((entry) => ['待提交', '同步失败'].includes(entry.syncState)).length ?? 0
  const conflict = batch?.entries.filter((entry) => entry.syncState === '冲突待裁决').length ?? 0
  const synced = batch?.entries.filter((entry) => entry.syncState === '已同步').length ?? 0

  const sidebar = (
    <div className="sidebar-inner">
      <div className="brand">
        <div className="brand-mark"><AuditOutlined /></div>
        <div><strong>无障碍整改中心</strong><small>企业数字体验治理</small></div>
      </div>
      <Menu mode="inline" theme="dark" items={items} selectedKeys={[location.pathname]} onClick={() => setOpen(false)} />
      <div className="sync-card">
        {online ? <Tag color="success" icon={<WifiOutlined />}>在线</Tag> : <Tag color="error" icon={<DisconnectOutlined />}>离线 · 数据仅本机</Tag>}
        {batch ? (
          <>
            <strong>{batch.name}</strong>
            <span>
              <Badge status="default" text={`待合并 ${pending}`} /> ·{' '}
              <Badge status={conflict ? 'error' : 'success'} text={`冲突 ${conflict}`} /> ·{' '}
              <Badge status="success" text={`已同步 ${synced}`} />
            </span>
            <Button size="small" type="primary" ghost icon={<CloudSyncOutlined />} onClick={() => navigate('/retest')}>返回复测批次</Button>
          </>
        ) : (
          <>
            <strong>规则库 2026.09</strong>
            <span>{lastSyncAt ? `最后同步 ${lastSyncAt}` : '尚未同步'}</span>
          </>
        )}
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
        {!online && (
          <div className="offline-strip" onClick={() => setSimulatedOffline(false)}>
            <DisconnectOutlined /> 离线模式：复测记录安全保存在本机，恢复网络后到复测工作台逐项合并（点击模拟恢复）
          </div>
        )}
        <Layout.Content><Outlet /></Layout.Content>
      </Layout>
    </Layout>
  )
}
