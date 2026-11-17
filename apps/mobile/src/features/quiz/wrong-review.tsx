import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { router } from 'expo-router';
import type { Question } from '@notelink/shared';
import { Text } from '@/components/text';
import { Btn, Canvas, Chip, Header, Input, Screen } from '@/components/ui';
import { today } from '@/lib/dates';
import { dropDb, readDb, writeDb } from '@/lib/local/storage';
import { useAuth } from '@/stores/auth';
import { AvatarCheer } from '@/features/tutor/cheer';
import { Avatar3D } from '@/features/tutor/avatar3d';
import { useEquippedAvatar } from '@/features/tutor/buddy';
import { useTour } from '@/features/tutor/tour';

// 오답 노트: 퀴즈에서 틀린 문제를 기기에 모아 두었다가, 하루에 처음 앱을 열 때 다시 풀게 한다.
// ponytail: 기기 저장(계정별 파일). 서버에 오답 목록 API가 생기면 그쪽으로 옮긴다
export type WrongQuestion = Pick<
  Question,
  '_id' | 'type' | 'prompt' | 'choices' | 'answer' | 'explanation'
> & { setTitle: string | null };
export type WrongNotes = { items: WrongQuestion[]; shownOn: string | null };

const MAX_ITEMS = 50; // 오래된 오답부터 밀려난다
export const DAILY_COUNT = 5; // 하루에 다시 푸는 문제 수
const EMPTY: WrongNotes = { items: [], shownOn: null };
const file = (userId: string) => `wrong-${userId}`;

/* ── 순수 계산(테스트 대상) ── */

/** 새로 틀린 문제를 맨 앞에 둔다(같은 문제는 한 번만) */
export const addWrong = (n: WrongNotes, q: WrongQuestion): WrongNotes => ({
  ...n,
  items: [q, ...n.items.filter((x) => x._id !== q._id)].slice(0, MAX_ITEMS),
});
export const dropWrong = (n: WrongNotes, id: string): WrongNotes => ({
  ...n,
  items: n.items.filter((x) => x._id !== id),
});
/** 오늘 아직 복습을 띄우지 않았고 오답이 있으면 다시 풀 문제들(오래된 것부터), 아니면 null */
export const dueOn = (n: WrongNotes, day: string) =>
  n.shownOn === day || n.items.length === 0 ? null : n.items.slice(-DAILY_COUNT).reverse();
/** 답 비교: 띄어쓰기 · 대소문자는 보지 않는다 */
export const sameAnswer = (a: string, b: string) =>
  a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase();

/* ── 기기 저장 ── */

/**
 * 저장된 오답 노트. 파일이 없으면(처음) 빈 노트, 있는데 읽지 못하거나 모양이 깨졌으면 던진다.
 * 읽기 실패를 빈 노트로 여기고 쓰면 그동안의 기록을 새 문제 하나로 덮어쓰기 때문이다(#341 리뷰)
 */
function readWrong(userId: string): WrongNotes {
  const v = readDb(file(userId)) as WrongNotes | null;
  if (v == null) return EMPTY;
  if (!Array.isArray(v.items)) throw new Error('오답 노트 파일 모양이 깨졌어요');
  return v;
}
/** 화면에 보여 줄 오답 노트. 읽지 못하면 빈 노트(파일은 건드리지 않는다) */
export function loadWrong(userId: string): WrongNotes {
  try {
    return readWrong(userId);
  } catch {
    return EMPTY;
  }
}
/** 못 적어도 복습 목록이 빠질 뿐이라 풀이를 막지 않는다 */
function save(userId: string, change: (n: WrongNotes) => WrongNotes) {
  try {
    // 읽지 못하면 여기서 던져 쓰지 않는다(남은 기록 보존)
    writeDb(file(userId), change(readWrong(userId)));
  } catch {
    // 다음에 틀리거나 맞힐 때 다시 적는다
  }
}
/**
 * 퀴즈에서 틀리면 오답 노트에 넣는다. 맞혀도 여기서는 빼지 않는다: 틀린 뒤 「다시 풀기」로 맞힌 문제도
 * 다음 날 복습해야 하고, 오답 노트에서는 오늘의 오답 복습에서 맞혔을 때만 뺀다
 */
export function recordWrong(userId: string | null, q: Question, setTitle?: string) {
  if (!userId) return;
  const { _id, type, prompt, choices, answer, explanation } = q;
  save(userId, (n) =>
    addWrong(n, { _id, type, prompt, choices, answer, explanation, setTitle: setTitle ?? null }),
  );
}

/** 회원 탈퇴: 그 계정의 오답 노트 파일을 지운다. 못 지워도 탈퇴는 막지 않는다(다시 쓸 일이 없는 파일) */
export function forgetWrongNotes(userId: string | null) {
  if (!userId) return;
  try {
    dropDb(file(userId));
  } catch {
    // 남아도 다른 계정에는 보이지 않는다
  }
}

/**
 * 하루에 처음 앱을 열면(또는 날이 바뀐 뒤 앱으로 돌아오면) 오답 복습을 연다. 처음 안내가 떠 있으면
 * 끝난 뒤에 연다. 하루에 한 번만 띄우고, 건너뛰어도 그날은 다시 띄우지 않는다.
 */
export function useDailyWrongReview(ready: boolean) {
  const userId = useAuth((s) => s.userId);
  const touring = useTour((s) => s.step >= 0);
  const [active, setActive] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (!ready || !userId || touring || !active) return;
    // 탭 화면이 자리를 잡은 뒤에 올린다
    const t = setTimeout(() => {
      const day = today();
      const notes = loadWrong(userId);
      if (notes.shownOn === day) return;
      // 그날 처음 열었을 때 확인했다고 적는다. 오답이 없어 띄우지 않은 날도 적어서, 그날 늦게 틀린 문제는
      // 다음 날 처음 열 때 복습한다(#341 리뷰)
      save(userId, (n) => ({ ...n, shownOn: day }));
      if (dueOn(notes, day)) router.push('/play/wrong');
    }, 600);
    return () => clearTimeout(t);
  }, [ready, userId, touring, active]);
}

/* ── 화면 ── */

const OX = ['O', 'X'];

export function WrongReviewScreen() {
  const userId = useAuth((s) => s.userId);
  const avatar = useEquippedAvatar();
  // 연 순간의 목록으로 푼다(푸는 동안 맞힌 문제가 빠져도 순서가 흔들리지 않게)
  const [qs] = useState(() =>
    userId ? loadWrong(userId).items.slice(-DAILY_COUNT).reverse() : [],
  );
  const [i, setI] = useState(0);
  const [typed, setTyped] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const q = qs[i];
  const done = i >= qs.length;
  const right = q && picked !== null ? sameAnswer(picked, q.answer) : null;

  const answer = (a: string) => {
    if (!q || picked !== null || !a.trim()) return;
    setPicked(a);
    const ok = sameAnswer(a, q.answer);
    if (ok) setScore((s) => s + 1);
    if (userId) save(userId, (n) => (ok ? dropWrong(n, q._id) : n));
  };
  const next = () => {
    setI((x) => x + 1);
    setPicked(null);
    setTyped('');
  };
  const options = q?.choices?.length ? q.choices : q?.type === 'ox' ? OX : null;

  return (
    <Canvas>
      <Screen
        footer={
          done ? (
            <Btn onPress={() => router.back()}>확인</Btn>
          ) : picked !== null ? (
            <Btn onPress={next}>{i + 1 < qs.length ? '다음 문제' : '복습 마치기'}</Btn>
          ) : !options ? (
            <Btn disabled={!typed.trim()} onPress={() => answer(typed)}>
              확인
            </Btn>
          ) : null
        }
      >
        <Header
          title="오늘의 오답 복습"
          sub={
            done
              ? undefined
              : `지난번에 틀린 문제 ${qs.length}개 중 ${Math.min(i + 1, qs.length)}번째`
          }
          large={false}
          right={
            !done && (
              <Btn small kind="ghost" onPress={() => router.back()}>
                건너뛰기
              </Btn>
            )
          }
        />
        {done ? (
          <View className="items-center pt-10">
            <View className="h-24 w-24 items-center justify-center overflow-hidden rounded-full bg-mint">
              <Avatar3D mood="talking" avatarId={avatar} size={92} framing="head" />
            </View>
            <Text className="mt-5 text-headline font-bold text-ink">
              {qs.length}문제 중 {score}문제를 맞혔어요
            </Text>
            <Text className="mt-1 text-center text-footnote leading-5 text-sub">
              {score === qs.length
                ? '모두 맞혔어요! 맞힌 문제는 오답 노트에서 뺐어요.'
                : '맞힌 문제는 오답 노트에서 뺐어요.\n아직 헷갈린 문제는 내일 다시 나와요.'}
            </Text>
          </View>
        ) : (
          q && (
            <View className="mt-2">
              {!!q.setTitle && <Text className="text-caption text-sub">{q.setTitle}</Text>}
              <Text className="mt-1 text-body font-bold leading-6 text-ink">Q. {q.prompt}</Text>
              {options ? (
                <View className="mt-4 gap-2">
                  {options.map((c) => (
                    <Chip
                      key={c}
                      on={picked === c}
                      onPress={() => answer(c)}
                      disabled={picked !== null}
                    >
                      {c}
                    </Chip>
                  ))}
                </View>
              ) : (
                <Input
                  className="mt-4"
                  value={typed}
                  onChangeText={setTyped}
                  editable={picked === null}
                  placeholder="답을 입력해 주세요"
                  returnKeyType="done"
                  onSubmitEditing={() => answer(typed)}
                />
              )}
              {right !== null && (
                <>
                  <View className="mt-4 rounded-xl bg-white px-4 py-3">
                    <Text
                      className={right ? 'text-footnote text-correct' : 'text-footnote text-danger'}
                    >
                      {right ? '정답이에요' : '아쉬워요, 정답은'}
                    </Text>
                    <Text className="mt-0.5 text-subhead font-bold text-ink">{q.answer}</Text>
                    {!!q.explanation && (
                      <Text className="mt-2 text-footnote leading-5 text-sub">{q.explanation}</Text>
                    )}
                  </View>
                  <AvatarCheer right={right} index={i} />
                </>
              )}
            </View>
          )
        )}
      </Screen>
    </Canvas>
  );
}
