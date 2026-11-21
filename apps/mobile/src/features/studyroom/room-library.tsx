import { useState } from 'react';
import { View } from 'react-native';
import { Pressable } from '@/components/press';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, ChevronRight, Share2 } from 'lucide-react-native';

import { Text } from '@/components/text';
import { Btn, Canvas, Header, Loading, Screen, cx } from '@/components/ui';
import { api } from '@/lib/api';
import { toast } from '@/stores/toast';
import { C, ICON } from '@/theme';

/**
 * 스터디룸을 떠나지 않고 내 폴더의 퀴즈 또는 저장한 플래시카드를 연다. 퀴즈는 하나씩, 카드는 골라서 방 채팅에 공유한다(#481)
 */
export function RoomLibraryScreen() {
  const { id, type } = useLocalSearchParams<{ id: string; type?: string }>();
  const isQuiz = type === 'quiz';
  const isCards = type === 'flashcards';
  const [folderId, setFolderId] = useState<string | null>(null);
  const [flipped, setFlipped] = useState<string[]>([]);
  // 카드 고르기: null이면 보기(누르면 뒤집기), 배열이면 고르는 중(누르면 고르기)
  const [picked, setPicked] = useState<string[] | null>(null);
  const share = useMutation({
    mutationFn: (body: Parameters<typeof api.rooms.shareStudyItem>[1]) =>
      api.rooms.shareStudyItem(id, body),
    onSuccess: (_r, body) => {
      toast(`방 채팅에 ${body.kind === 'quiz' ? '퀴즈를' : '플래시카드를'} 공유했어요`);
      router.back();
    },
    onError: () => toast('공유하지 못했어요. 다시 시도해 주세요'),
  });
  const togglePick = (cardId: string) =>
    setPicked((p) =>
      p?.includes(cardId) ? p.filter((x) => x !== cardId) : [...(p ?? []), cardId],
    );
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
              setPicked(null);
            }}
          >
            폴더 목록
          </Btn>
        )}
        {selected && isCards && (
          <Btn
            kind="outline"
            small
            className="mt-2"
            onPress={() => setPicked((p) => (p ? null : []))}
          >
            {picked ? '고르기 취소' : '골라서 공유'}
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
              <View
                key={quiz._id}
                className="mt-3 flex-row items-center rounded-xl bg-white py-1 pl-4 pr-2"
              >
                <Pressable
                  accessibilityRole="button"
                  onPress={() =>
                    router.push({
                      pathname: '/play/solve',
                      params: { setId: quiz._id, from: 'room' },
                    })
                  }
                  className="flex-1 flex-row items-center py-3"
                >
                  <View className="flex-1">
                    <Text className="text-callout font-semibold text-ink">{quiz.title}</Text>
                    <Text className="mt-1 text-caption text-sub">{quiz.questionCount}문제</Text>
                  </View>
                  <ChevronRight size={ICON.sm} color={C.sub} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${quiz.title} 방에 공유`}
                  disabled={share.isPending}
                  onPress={() => share.mutate({ kind: 'quiz', quizSetId: quiz._id })}
                  hitSlop={6}
                  className="ml-2 flex-row items-center gap-1 rounded-full bg-mint px-3 py-2"
                >
                  <Share2 size={ICON.xs} color={C.brand} />
                  <Text className="text-caption font-semibold text-brand">공유</Text>
                </Pressable>
              </View>
            ))}
        {selected &&
          isCards &&
          cardList
            .filter((card) => inFolder(card.folderId))
            .map((card) => {
              const back = flipped.includes(card._id);
              const on = !!picked?.includes(card._id);
              return (
                <Pressable
                  key={card._id}
                  accessibilityRole="button"
                  accessibilityLabel={`${back ? '정답' : '문제'}: ${back ? card.back : card.front}. ${picked ? '눌러서 고르기' : '눌러서 카드를 뒤집기'}`}
                  onPress={() =>
                    picked
                      ? togglePick(card._id)
                      : setFlipped((prev) =>
                          back ? prev.filter((x) => x !== card._id) : [...prev, card._id],
                        )
                  }
                  className={cx(
                    'mt-3 rounded-xl px-4 py-5',
                    back ? 'bg-brand' : 'bg-white',
                    picked && 'pr-12',
                    on && 'border-2 border-brand',
                  )}
                >
                  {picked && (
                    <Pressable
                      accessibilityRole="checkbox"
                      accessibilityLabel={`${card.front} 고르기`}
                      accessibilityState={{ checked: on }}
                      onPress={() => togglePick(card._id)}
                      hitSlop={10}
                      className={cx(
                        'absolute right-3 top-3 h-6 w-6 items-center justify-center rounded-md border-2',
                        on ? 'border-brand bg-brand' : 'border-line bg-white',
                      )}
                    >
                      {on && <Check size={ICON.xs} color="#fff" />}
                    </Pressable>
                  )}
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
              );
            })}
        {picked && (
          <Btn
            className="mt-4"
            disabled={picked.length === 0}
            loading={share.isPending}
            onPress={() => share.mutate({ kind: 'flashcards', flashcardIds: picked })}
          >
            {picked.length ? `${picked.length}장 방에 공유` : '공유할 카드를 골라 주세요'}
          </Btn>
        )}
      </Screen>
    </Canvas>
  );
}
