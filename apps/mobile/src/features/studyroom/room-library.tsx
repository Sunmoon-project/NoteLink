import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react-native';

import { Text } from '@/components/text';
import { Btn, Canvas, Header, Loading, Screen, cx } from '@/components/ui';
import { api } from '@/lib/api';
import { C, ICON } from '@/theme';
import { toast } from '@/stores/toast';

/** 스터디룸을 떠나지 않고 내 폴더의 퀴즈 또는 저장한 플래시카드를 연다. */
export function RoomLibraryScreen() {
  const { id, type } = useLocalSearchParams<{ id: string; type?: string }>();
  const share = useMutation({
    mutationFn: ({ kind, itemId }: { kind: 'quiz' | 'flashcards'; itemId: string }) =>
      api.rooms.shareStudyItem(id, kind, itemId),
    onSuccess: () => {
      toast('스터디룸 채팅에 공유했어요');
      router.dismissTo({ pathname: '/room/[id]', params: { id } });
    },
    onError: () => toast('공유하지 못했어요. 다시 시도해 주세요'),
  });
  const isQuiz = type === 'quiz';
  const isCards = type === 'flashcards';
  const [folderId, setFolderId] = useState<string | null>(null);
  const [flipped, setFlipped] = useState<string[]>([]);
  const folders = useQuery({
    queryKey: ['folders'],
    queryFn: api.content.folders,
    enabled: isQuiz || isCards,
  });
  const quizzes = useQuery({ queryKey: ['quiz-sets'], queryFn: api.quiz.sets, enabled: isQuiz });
  const cards = useQuery({
    queryKey: ['flashcards'],
    queryFn: api.quiz.flashcards,
    enabled: isCards,
  });
  if (!isQuiz && !isCards) {
    return (
      <Canvas>
        <Screen>
          <Header title="학습 자료" large={false} />
          <Text className="py-12 text-center text-footnote text-sub">
            자료 유형을 선택해 주세요
          </Text>
        </Screen>
      </Canvas>
    );
  }
  const data = isQuiz ? quizzes : cards;
  const readyQuizzes = (quizzes.data ?? []).filter((quiz) => quiz.status === 'ready');
  const cardList = cards.data ?? [];
  const items = isQuiz ? readyQuizzes : cardList;
  const groups = (folders.data ?? [])
    .map((folder) => ({
      id: folder._id,
      title: folder.title,
      count: items.filter((item) => item.folderId === folder._id).length,
    }))
    .filter((group) => group.count > 0);
  const knownFolders = new Set((folders.data ?? []).map((folder) => folder._id));
  const unfiled = items.filter((item) => !item.folderId || !knownFolders.has(item.folderId));
  if (unfiled.length) groups.push({ id: '__unfiled__', title: '폴더 없음', count: unfiled.length });
  const selected = groups.find((group) => group.id === folderId);
  const inFolder = (id: string | null) =>
    folderId === '__unfiled__' ? !id || !knownFolders.has(id) : id === folderId;

  return (
    <Canvas>
      <Screen>
        <Header title={selected?.title ?? (isQuiz ? '내 퀴즈' : '내 플래시 카드')} large={false} />
        {selected && (
          <Btn
            kind="outline"
            small
            onPress={() => {
              setFolderId(null);
              setFlipped([]);
            }}
          >
            폴더 목록
          </Btn>
        )}
        {(folders.isPending || data.isPending) && <Loading />}
        {(folders.isError || data.isError) && (!folders.data || !data.data) && (
          <View className="items-center gap-3 py-12">
            <Text className="text-center text-footnote text-sub">자료를 불러오지 못했어요</Text>
            <Btn
              small
              onPress={() => {
                if (folders.isError) void folders.refetch();
                if (data.isError) void data.refetch();
              }}
            >
              다시 시도
            </Btn>
          </View>
        )}
        {folders.data && data.data && groups.length === 0 && (
          <Text className="py-12 text-center text-footnote text-sub">
            {isQuiz ? '풀 수 있는 퀴즈가 없어요' : '저장한 플래시 카드가 없어요'}
          </Text>
        )}
        {!selected &&
          folders.data &&
          data.data &&
          groups.map((group) => (
            <Pressable
              key={group.id}
              accessibilityRole="button"
              onPress={() => setFolderId(group.id)}
              className="mt-3 flex-row items-center justify-between rounded-xl bg-white px-4 py-4"
            >
              <View>
                <Text className="text-callout font-semibold text-ink">{group.title}</Text>
                <Text className="mt-1 text-caption text-sub">
                  {group.count}
                  {isQuiz ? '개 퀴즈' : '장 카드'}
                </Text>
              </View>
              <ChevronRight size={ICON.sm} color={C.sub} />
            </Pressable>
          ))}
        {selected &&
          isQuiz &&
          readyQuizzes
            .filter((quiz) => inFolder(quiz.folderId))
            .map((quiz) => (
              <View key={quiz._id}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() =>
                    router.push({
                      pathname: '/play/solve',
                      params: { setId: quiz._id, from: 'room' },
                    })
                  }
                  className="mt-3 flex-row items-center justify-between rounded-xl bg-white px-4 py-4"
                >
                  <View className="flex-1">
                    <Text className="text-callout font-semibold text-ink">{quiz.title}</Text>
                    <Text className="mt-1 text-caption text-sub">{quiz.questionCount}문제</Text>
                  </View>
                  <ChevronRight size={ICON.sm} color={C.sub} />
                </Pressable>
                <Btn
                  small
                  kind="outline"
                  disabled={share.isPending}
                  onPress={() => share.mutate({ kind: 'quiz', itemId: quiz._id })}
                >
                  퀴즈 공유하기
                </Btn>
              </View>
            ))}
        {selected &&
          isCards &&
          cardList
            .filter((card) => inFolder(card.folderId))
            .map((card) => {
              const back = flipped.includes(card._id);
              return (
                <View key={card._id}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${back ? '정답' : '문제'}: ${back ? card.back : card.front}. 눌러서 카드를 뒤집기`}
                    onPress={() =>
                      setFlipped((prev) =>
                        back ? prev.filter((id) => id !== card._id) : [...prev, card._id],
                      )
                    }
                    className={cx('mt-3 rounded-xl px-4 py-5', back ? 'bg-brand' : 'bg-white')}
                  >
                    <Text className={cx('text-caption', back ? 'text-white' : 'text-sub')}>
                      {back ? '정답' : '문제'}
                    </Text>
                    <Text
                      className={cx(
                        'mt-2 text-callout font-semibold',
                        back ? 'text-white' : 'text-ink',
                      )}
                    >
                      {back ? card.back : card.front}
                    </Text>
                  </Pressable>
                  <Btn
                    small
                    kind="outline"
                    disabled={share.isPending}
                    onPress={() => share.mutate({ kind: 'flashcards', itemId: card._id })}
                  >
                    플래시 카드 공유하기
                  </Btn>
                </View>
              );
            })}
      </Screen>
    </Canvas>
  );
}
