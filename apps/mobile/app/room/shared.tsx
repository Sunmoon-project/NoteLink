import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Text } from '@/components/text';
import { Btn, Canvas, Header, Loading, Screen } from '@/components/ui';
import { api } from '@/lib/api';

export default function SharedStudyItemScreen() {
  const { id, itemId } = useLocalSearchParams<{ id: string; itemId: string }>();
  const [shown, setShown] = useState<number[]>([]);
  const item = useQuery({
    queryKey: ['room-shared-item', id, itemId],
    queryFn: () => api.rooms.sharedItem(id, itemId),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  const toggle = (index: number) =>
    setShown((values) =>
      values.includes(index) ? values.filter((v) => v !== index) : [...values, index],
    );
  return (
    <Canvas>
      <Screen>
        <Header title="공유 학습 자료" large={false} />
        {(item.isPending || item.isFetching) && <Loading />}
        {item.isError && (
          <View>
            <Text>공유 자료를 불러오지 못했어요</Text>
            <Btn onPress={() => void item.refetch()}>다시 시도</Btn>
          </View>
        )}
        {!item.isFetching && !item.isError && item.data?.itemType === 'quiz' && (
          <>
            <Text className="mt-4 text-body font-bold text-ink">{item.data.quiz.title}</Text>
            {item.data.quiz.questions.map((q, index) => (
              <View key={q._id} className="mt-3 rounded-xl bg-white p-4">
                <Text className="text-footnote text-ink">
                  {index + 1}. {q.prompt}
                </Text>
                {q.choices?.map((choice, i) => (
                  <Text key={i} className="mt-1 text-caption text-sub">
                    {i + 1}. {choice}
                  </Text>
                ))}
                <Pressable accessibilityRole="button" onPress={() => toggle(index)}>
                  <Text className="mt-2 text-brand">
                    {shown.includes(index) ? `정답: ${q.answer}` : '정답 보기'}
                  </Text>
                </Pressable>
              </View>
            ))}
          </>
        )}
        {!item.isFetching &&
          !item.isError &&
          item.data?.itemType === 'flashcards' &&
          item.data.cards.map((card, index) => (
            <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityLabel={`${shown.includes(index) ? '정답' : '문제'}: ${shown.includes(index) ? card.back : card.front}. 눌러서 카드를 뒤집기`}
              onPress={() => toggle(index)}
              className="mt-3 rounded-xl bg-white p-4"
            >
              <Text>{shown.includes(index) ? card.back : card.front}</Text>
            </Pressable>
          ))}
      </Screen>
    </Canvas>
  );
}
