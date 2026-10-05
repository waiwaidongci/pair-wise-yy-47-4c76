import type { Issue, WatchedField } from '../api/types'

/** 三方版本比对时按字段取值；复测备注以最近一条复测记录为准 */
export function getFieldValue(issue: Issue | undefined, field: WatchedField): string {
  if (!issue) return '（无）'
  switch (field) {
    case 'status':
      return issue.status
    case 'rootCause':
      return issue.rootCause
    case 'fixNote':
      return issue.fixNote ?? '（未提交修复说明）'
    case 'retestEnv':
      return issue.retestEnv ?? '（未记录复测环境）'
    case 'retestEvidence':
      return issue.retestEvidence ?? '（未上传复测证据）'
    case 'retestNote':
      return issue.retestRecords.at(-1)?.note ?? '（无复测备注）'
  }
}
