import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { StrategyStatus } from '~/components/StrategyStatusBadge';
import { api, readJson } from '~/lib/api-client';

/**
 * Pause / resume a strategy with an optimistic cache update.
 *
 * This flow was duplicated between the list and detail routes — two copies of a
 * non-trivial rollback (both query keys, both cache shapes) that had to stay in
 * step. The routes pass their own richer row/detail types; only the fields
 * touched here are required, so this works against either shape.
 */

/** The two transitions the UI exposes: pause and resume. */
export type StrategyStatusAction = 'active' | 'paused';

/** The minimum a cached strategy must expose to be patched optimistically. */
interface StatusPatchable {
  id: string;
  status: StrategyStatus;
}

/** Shape of the paginated list cache written by the strategies route. */
interface StrategyListCache {
  strategies: StatusPatchable[];
}

export interface StrategyStatusChange {
  id: string;
  status: StrategyStatusAction;
}

export function useStrategyStatusMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, status }: StrategyStatusChange) => {
      const res = await api.strategies[':id'].$patch({ param: { id }, json: { status } });
      return readJson<{ success: boolean }>(res, 'Update strategy');
    },

    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: ['strategies'] });
      await queryClient.cancelQueries({ queryKey: ['strategy', id] });

      const lists = queryClient.getQueriesData<StrategyListCache>({ queryKey: ['strategies'] });
      const detail = queryClient.getQueryData<StatusPatchable>(['strategy', id]);

      queryClient.setQueriesData<StrategyListCache>({ queryKey: ['strategies'] }, (old) =>
        old
          ? { ...old, strategies: old.strategies.map((s) => (s.id === id ? { ...s, status } : s)) }
          : old,
      );
      if (detail) {
        queryClient.setQueryData<StatusPatchable>(['strategy', id], { ...detail, status });
      }

      return { lists, detail };
    },

    onError: (_error, { id }, context) => {
      for (const [key, snapshot] of context?.lists ?? []) queryClient.setQueryData(key, snapshot);
      if (context?.detail) queryClient.setQueryData(['strategy', id], context.detail);
    },

    onSettled: (_data, _error, { id }) => {
      void queryClient.invalidateQueries({ queryKey: ['strategies'] });
      void queryClient.invalidateQueries({ queryKey: ['strategy', id] });
    },
  });
}
