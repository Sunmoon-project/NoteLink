import * as SecureStore from 'expo-secure-store';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/stores/auth';
import { toast } from '@/stores/toast';

/** 기기별 캘린더 표시 설정. 서버의 개별 공휴일 숨김과 별개로 계정마다 보존한다. */
export function useHolidayPreference() {
  const userId = useAuth((s) => s.userId) ?? 'guest';
  const qc = useQueryClient();
  const key = ['holiday-auto', userId];
  const storageKey = `notelink.holiday-auto.${userId}`;
  const query = useQuery({
    queryKey: key,
    queryFn: async () => (await SecureStore.getItemAsync(storageKey)) !== 'false',
  });
  return {
    auto: query.data ?? true,
    setAuto: async (value: boolean) => {
      try {
        await SecureStore.setItemAsync(storageKey, String(value));
        qc.setQueryData(key, value);
      } catch {
        toast('공휴일 설정을 저장하지 못했어요. 다시 시도해 주세요');
      }
    },
  };
}
