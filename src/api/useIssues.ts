import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchIssues } from './client'
import { useWorkspaceStore } from '../store/useWorkspaceStore'
import { useOnline } from '../lib/useOnline'

export function useIssues() {
  const hydrateFromServer = useWorkspaceStore((state) => state.hydrateFromServer)
  const online = useOnline()

  const query = useQuery({
    queryKey: ['issues'],
    queryFn: fetchIssues,
    enabled: online,
    retry: false,
    staleTime: 20_000,
  })

  useEffect(() => {
    if (query.data) hydrateFromServer(query.data)
  }, [query.data, hydrateFromServer])

  // 断网恢复后重新拉取；有活动批次时只刷新远端视图，确认视图保持冻结（见 hydrateFromServer）
  useEffect(() => {
    if (online) void query.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online])

  return query
}
