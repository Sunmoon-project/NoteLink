import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Material } from '@notelink/shared';
import { api, ApiError } from '@/lib/api';
import { toast } from '@/stores/toast';
import { useRetrying } from '@/stores/retrying';

/** 정리 중으로 보이게 바꾼 자료(다시 요약을 넣었는데 아직 그 상태를 읽지 못함) */
export const asQueued = (m: Material): Material => ({
  ...m,
  processing: { ...m.processing, status: 'queued', progress: 0 },
});

/**
 * 요약에 실패한 자료의 「다시 요약」: 그 자료의 정리 작업을 다시 넣는다(서버가 자료 상태도 함께 되돌린다).
 * 폴더 목록 · 노트 상세가 같이 쓴다. 바로 정리 중으로 보이고, 끝날 때까지 폴더 목록은 이 자료를 따로 읽는다(readFolderMaterials)
 */
export function useResummarize() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (m: Material) => api.ai.retry(m.processing.jobId!),
    onSuccess: (_job, m) => {
      useRetrying.getState().track(m.folderId, m._id);
      qc.setQueryData<Material[]>(['materials', m.folderId], (list) =>
        list?.map((x) => (x._id === m._id ? asQueued(x) : x)),
      );
      qc.setQueryData<Material>(['material', m._id], (x) => x && asQueued(x));
      void qc.invalidateQueries({ queryKey: ['materials'] });
      toast('다시 요약하고 있어요. 끝나면 알려 드릴게요');
    },
    onError: (e) =>
      toast(e instanceof ApiError ? e.message : '다시 요약하지 못했어요. 잠시 뒤 다시 눌러 주세요'),
  });
}
