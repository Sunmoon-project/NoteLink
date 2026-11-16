import { View } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarCheck } from 'lucide-react-native';
import { Text } from '@/components/text';
import { Card, Progress } from '@/components/ui';
import { api } from '@/lib/api';
import { env } from '@/lib/env';
import { C, ICON } from '@/theme';

/** 오늘의 복습 세트(서버가 하루 한 번 만든다). 만드는 중이면 2초마다 다시 읽는다 */
export function useTodayReview() {
  return useQuery({
    queryKey: ['today-review'],
    queryFn: api.quiz.today,
    // 기기 저장 모드는 기기 오답 노트(wrong-review)가 오늘 복습을 맡는다
    enabled: !env.localData,
    refetchInterval: (q) => (q.state.data?.status === 'generating' ? 2000 : false),
  });
}

/**
 * 퀴즈 탭의 「오늘의 복습」 카드. 복습 날짜가 된 문제를 모든 퀴즈에서 모은 세트(today_review)를
 * 만드는 중이면 진행률을, 다 만들었으면 바로 풀게 한다. 오늘 복습할 문제가 없으면(failed) 그리지 않는다
 */
export function TodayReviewCard() {
  const today = useTodayReview();
  const s = today.data;
  if (!s || s.status === 'failed') return null;
  const ready = s.status === 'ready';
  return (
    <Card
      tone="white"
      className="mt-4 p-5"
      onPress={
        ready ? () => router.push({ pathname: '/play/solve', params: { setId: s._id } }) : undefined
      }
    >
      <View className="flex-row items-center gap-2">
        <CalendarCheck size={ICON.sm} color={C.brand} />
        <Text className="text-caption font-semibold text-brand">오늘의 복습</Text>
      </View>
      <Text className="mt-1 text-body font-bold text-ink">
        {ready ? `복습 날짜가 된 ${s.questionCount}문제 풀기` : '복습할 문제를 모으고 있어요'}
      </Text>
      {ready ? (
        <Text className="mt-0.5 text-caption text-sub">
          지난 퀴즈에서 틀렸거나 다시 볼 때가 된 문제예요
        </Text>
      ) : (
        <Progress value={s.progress} className="mt-2" />
      )}
    </Card>
  );
}
