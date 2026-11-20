import { useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { Flashcard, Question } from '@notelink/shared';

import { Pressable } from '@/components/press';
import { Text, TextInput } from '@/components/text';
import { Btn, Canvas, Header, Loading, Screen, cx } from '@/components/ui';
import { api } from '@/lib/api';

/**
 * 방 멤버가 공유받은 퀴즈 · 플래시카드 묶음(#481). 퀴즈는 남의 세트라 서버 풀이를 만들지 않고 기기에서 채점한다 —
 * 내 풀이 기록 · 복습 · 보관함 · 포인트에 남지 않는다. 카드는 고른 순서대로 보고 눌러서 뒤집는다
 */
export function RoomSharedItemScreen() {
  const { id, item } = useLocalSearchParams<{ id: string; item: string }>();
  const shared = useQuery({
    queryKey: ['room-shared-item', id, item],
    queryFn: () => api.rooms.sharedItem(id, item),
    retry: false,
  });
  if (shared.isPending) return <Loading />;
  if (!shared.data)
    return (
      <Canvas>
        <Screen>
          <Header title="공유 자료" large={false} />
          <View className="items-center gap-3 py-12">
            <Text className="text-center text-footnote text-sub">
              지워졌거나 더 볼 수 없는 자료예요
            </Text>
            <Btn small onPress={() => void shared.refetch()}>
              다시 시도
            </Btn>
          </View>
        </Screen>
      </Canvas>
    );
  const { item: info, quiz, flashcards } = shared.data;
  const by = `${info.sharedByNickname}님이 공유했어요`;
  return (
    <Canvas>
      <Screen>
        <Header
          title={info.title}
          sub={quiz ? `${by} · 풀어도 내 기록에는 남지 않아요` : by}
          large={false}
        />
        {quiz ? <SharedQuiz questions={quiz.questions} /> : <SharedCards cards={flashcards} />}
      </Screen>
    </Canvas>
  );
}

/** 기기에서만 채점하는 풀이. 답은 앞뒤 공백을 빼고 정답과 같으면 맞음(서버 채점과 같은 기준) */
function SharedQuiz({ questions }: { questions: Question[] }) {
  const [i, setI] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  const q = questions[i];
  if (!q) {
    const right = answers.filter((a, n) => a === questions[n]?.answer).length;
    return (
      <View className="items-center gap-4 py-12">
        <Text className="text-headline font-bold text-ink">
          {questions.length}문제 중 {right}문제 맞혔어요
        </Text>
        <Btn
          onPress={() => {
            setI(0);
            setAnswers([]);
          }}
        >
          다시 풀기
        </Btn>
      </View>
    );
  }
  const answered = answers[i];
  const grade = (a: string) => {
    if (answered !== undefined || !a.trim()) return;
    setAnswers((x) => [...x, a.trim()]);
  };
  const last = i === questions.length - 1;
  return (
    <View className="mt-2 gap-3">
      <Text className="text-caption text-sub">
        {i + 1} / {questions.length}
      </Text>
      <Text className="text-callout font-semibold leading-6 text-ink">{q.prompt}</Text>
      {q.choices ? (
        q.choices.map((c) => (
          <Pressable
            key={c}
            accessibilityRole="button"
            disabled={answered !== undefined}
            onPress={() => grade(c)}
            className={cx(
              'rounded-xl border px-4 py-3.5',
              answered === undefined
                ? 'border-transparent bg-white'
                : c === q.answer
                  ? 'border-brand bg-mint'
                  : c === answered
                    ? 'border-danger bg-white'
                    : 'border-transparent bg-white',
            )}
          >
            <Text className="text-footnote text-ink">{c}</Text>
          </Pressable>
        ))
      ) : (
        <View className="gap-2">
          <TextInput
            value={typed}
            onChangeText={setTyped}
            editable={answered === undefined}
            placeholder="답을 입력하세요"
            className="rounded-xl bg-white px-4 py-3.5 text-footnote text-ink"
          />
          {answered === undefined && (
            <Btn disabled={!typed.trim()} onPress={() => grade(typed)}>
              채점하기
            </Btn>
          )}
        </View>
      )}
      {answered !== undefined && (
        <View className="gap-1 rounded-xl bg-white px-4 py-3">
          <Text
            className={cx(
              'text-footnote font-bold',
              answered === q.answer ? 'text-brand' : 'text-danger',
            )}
          >
            {answered === q.answer ? '맞았어요' : `틀렸어요 · 정답: ${q.answer}`}
          </Text>
          {!!q.explanation && <Text className="text-caption text-sub">{q.explanation}</Text>}
        </View>
      )}
      {answered !== undefined && (
        <Btn
          onPress={() => {
            setI((n) => n + 1);
            setTyped('');
          }}
        >
          {last ? '결과 보기' : '다음 문제'}
        </Btn>
      )}
    </View>
  );
}

function SharedCards({ cards }: { cards: Flashcard[] }) {
  const [flipped, setFlipped] = useState<string[]>([]);
  return cards.map((card) => {
    const back = flipped.includes(card._id);
    return (
      <Pressable
        key={card._id}
        accessibilityRole="button"
        accessibilityLabel={`${back ? '정답' : '문제'}: ${back ? card.back : card.front}. 눌러서 카드를 뒤집기`}
        onPress={() =>
          setFlipped((p) => (back ? p.filter((x) => x !== card._id) : [...p, card._id]))
        }
        className={cx('mt-3 rounded-xl px-4 py-5', back ? 'bg-brand' : 'bg-white')}
      >
        <Text className={cx('text-caption', back ? 'text-white' : 'text-sub')}>
          {back ? '정답' : '문제'}
        </Text>
        <Text className={cx('mt-2 text-callout font-semibold', back ? 'text-white' : 'text-ink')}>
          {back ? card.back : card.front}
        </Text>
      </Pressable>
    );
  });
}
