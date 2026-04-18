import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { plansApi } from '@/features/plans/plans-api'

type PlansData = Awaited<ReturnType<typeof plansApi.getPlans>>

export function usePlansQuery(): UseQueryResult<PlansData> {
  return useQuery({
    queryKey: ['plans'],
    queryFn: () => plansApi.getPlans(),
  })
}
