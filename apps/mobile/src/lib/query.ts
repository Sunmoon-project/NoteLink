import { MutationCache, QueryClient } from '@tanstack/react-query';
import { NetworkError } from './api';
import { toast } from '@/stores/toast';

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (_error, _variables, _context, mutation) => {
      if (!mutation.options.onError)
        toast('요청을 완료하지 못했어요. 연결을 확인하고 다시 시도해주세요');
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // 연결 문제는 자동 재시도, 서버가 거절한 요청은 다시 보내지 않는다 (p.97)
      retry: (n, e) => e instanceof NetworkError && n < 3,
    },
    // 쓰기 요청의 응답 유실은 실패 확정이 아니므로 사용자의 재확인 없이 재전송하지 않는다.
    mutations: { retry: false },
  },
});
