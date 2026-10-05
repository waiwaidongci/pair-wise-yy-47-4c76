import { useNavigate } from 'react-router-dom'
import { Alert, Button } from 'antd'
import { useRetestStore } from '../store/useRetestStore'

/** 冲突未处理时，台账/版本/报告继续显示上一个确认版本的全局提示 */
export default function ConflictNotice() {
  const navigate = useNavigate()
  const conflicts = useRetestStore((state) => state.entries.filter((entry) => entry.status === 'conflict'))
  if (!conflicts.length) return null
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 14 }}
      message={`有 ${conflicts.length} 项复测冲突未处理，当前显示上一个确认版本`}
      description="问题台账、版本差异和整改报告仍显示上一个确认版本的数据。请逐项核对我方与对方版本及冲突字段，处理完成后台账才会更新。"
      action={
        <Button size="small" type="primary" onClick={() => navigate('/retest')}>
          前往处理冲突
        </Button>
      }
    />
  )
}
