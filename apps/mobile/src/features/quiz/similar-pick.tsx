import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Sparkles } from 'lucide-react-native';
import { SIMILAR_PICK_MAX, type Question, type QuizSet } from '@notelink/shared';
import { Pressable } from '@/components/press';
import { Text } from '@/components/text';
import { NetBanner } from '@/components/NetBanner';
import {
  Btn,
  Canvas,
  cx,
  Empty,
  Group,
  Header,
  Label,
  Loading,
  Progress,
  Screen,
} from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { C, ICON } from '@/theme';

/**
 * 유사 퀴즈를 만들고 다 만들 때까지 기다린다. 서버는 세트를 만드는 중(generating)으로 돌려주므로 다 만들 때까지 세트를
 * 다시 읽고, 다 만들면 일반 퀴즈와 같은 흐름(풀이 → 결과 · 정답 · AI 해설)으로 넘어간다.
 * 결과 화면에서 세트 하나로 만들기와 노트에서 문제를 골라 만들기(#605)가 같이 쓴다
 */
export function useSimilarMaking<A>(make: (arg: A) => Promise<QuizSet>) {
  const qc = useQueryClient();
  const generate = useMutation({
    mutationFn: make,
    retry: false,
    // 실패 문구는 화면 아래에 직접 보여 주므로 공용 토스트는 띄우지 않는다. 같은 노트로 만드는 중이라 막혔을 수 있어(409)
    // 세트 목록을 다시 읽는다: 고르기 화면이 그 세트를 보고 끝날 때까지 만들기를 막는다(code-review 3차)
    onError: () => void qc.invalidateQueries({ queryKey: ['quiz-sets'] }),
  });
  const making = generate.data?.status === 'generating' ? generate.data._id : null;
  const poll = useQuery({
    queryKey: ['quiz-set', making],
    queryFn: () => api.quiz.set(making!),
    enabled: !!making,
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'generating' ? false : 1500),
  });
  const done =
    poll.data && poll.data.status === 'ready'
      ? poll.data
      : generate.data?.status === 'ready'
        ? generate.data
        : null;
  const failed = poll.data?.status === 'failed' || generate.data?.status === 'failed';
  useEffect(() => {
    if (!done) return;
    qc.invalidateQueries({ queryKey: ['quiz-sets'] });
    router.replace({ pathname: '/play/solve', params: { setId: done._id } });
  }, [done?._id]); // eslint-disable-line react-hooks/exhaustive-deps
  // 결과 조회가 실패하면(연결 끊김 · 서버 오류) 「만드는 중」만 되풀이하지 않고 알린 뒤 다시 확인하게 한다
  // 앞서 받은 진행 상태(generating)가 남아 있어도 마지막 조회가 실패했으면 알린다(다 만든 · 실패한 세트는 제외)
  const checkFailed = !!making && poll.isError && !done && !failed;
  const waiting = (!!making && !done && !failed && !checkFailed) || !!done;
  return { generate, poll, failed, checkFailed, waiting };
}

/** 만드는 중 진행률 · 결과 확인 실패 · 만들기 실패 문구 */
export function SimilarStatus({
  s,
}: {
  s: {
    generate: { isError: boolean; error: unknown };
    poll: { data?: QuizSet };
    failed: boolean;
    checkFailed: boolean;
    waiting: boolean;
  };
}) {
  const { generate, poll, failed, checkFailed, waiting } = s;
  return (
    <>
      {checkFailed && (
        <Text className="text-center text-footnote leading-5 text-danger">
          만든 결과를 확인하지 못했어요. 연결을 확인하고 다시 확인해 주세요.
        </Text>
      )}
      {waiting && (
        <View className="items-center">
          <Progress value={poll.data?.progress ?? 0} className="w-40" />
          <Text className="mt-2 text-center text-footnote leading-5 text-sub">
            비슷한 문제를 만들고 있어요 · {poll.data?.progress ?? 0}%
          </Text>
        </View>
      )}
      {(generate.isError || failed) && (
        <Text className="text-center text-footnote leading-5 text-danger">
          {generate.error instanceof ApiError && !failed
            ? generate.error.message
            : '생성 결과를 받지 못했어요. 다시 시도하면 새로 만들어요.'}
        </Text>
      )}
    </>
  );
}

/**
 * 유사 퀴즈를 만들 수 있는 세트: 끝까지 푼 ready 세트 중 노트 · 학습 폴더가 있는 것. 오늘의 복습 세트(노트를 섞음)는
 * 뺀다. 서버(SimilarQuizService.createFromPicks)가 받는 세트와 같은 규칙. 퀴즈 홈 바로가기도 이것으로 보인다.
 * 폴더 정보가 없는 옛 세트는 1단계(폴더)로 찾아갈 수 없으므로 뺀다(결과 화면의 유사 퀴즈로는 그대로 만든다)
 */
export const canPickFrom = (s: QuizSet) =>
  s.status === 'ready' &&
  !!s.completed &&
  !s.reviewDay &&
  !!s.materialId &&
  !!s.folderId &&
  s.questions.length > 0;

/**
 * 새 세트가 들어갈 노트: 고른 문제가 가장 많은 노트, 같으면 먼저(화면 차례) 고른 쪽. 서버(createFromPicks)와 같은 규칙.
 * 서버는 노트마다 만드는 중인 세트를 하나만 두므로 이 노트로 만드는 중인 세트가 있으면 409다
 */
export function noteOf(ids: string[], sets: QuizSet[]): string | null {
  const count = new Map<string, number>();
  for (const id of ids) {
    const s = sets.find((x) => x.questions.some((q) => q._id === id));
    if (s) count.set(s.materialId, (count.get(s.materialId) ?? 0) + 1);
  }
  let best: [string, number] | null = null;
  for (const e of count) if (!best || e[1] > best[1]) best = e;
  return best?.[0] ?? null;
}

/** 2단계에 보이는 세트: 그 노트(학습 폴더)에서 고를 수 있는 세트 */
export function pickableSets(sets: QuizSet[] | undefined, folderId: string): QuizSet[] {
  return (sets ?? []).filter((s) => canPickFrom(s) && s.folderId === folderId);
}

/** 처음 체크해 둘 문제: 세트 차례(최근 것부터)대로 마지막 풀이에서 틀린 문제, 상한까지 */
export function defaultPicks(sets: QuizSet[], max = SIMILAR_PICK_MAX): string[] {
  const ids = sets.flatMap((s) => {
    const wrong = new Set(s.wrongQuestionIds ?? []);
    return s.questions.filter((q) => wrong.has(q._id)).map((q) => q._id);
  });
  return ids.slice(0, max);
}

const Box = ({ on }: { on: boolean }) => (
  <View
    className={cx(
      'h-6 w-6 items-center justify-center rounded-full',
      on ? 'bg-brand' : 'border border-cream-2',
    )}
  >
    {on && <Check size={ICON.xs} color="#fff" />}
  </View>
);

/**
 * 유사 퀴즈 2단계(#605): 고른 노트에서 끝까지 푼 퀴즈의 문제를 세트별로 보여 주고, 마지막 풀이에서 틀린 문제는 처음부터
 * 체크해 둔다. 고른 문제(SIMILAR_PICK_MAX개까지)로 만든다. 하나도 고르지 않으면 만들 수 없다
 */
export function SimilarPickScreen({ folderId }: { folderId: string }) {
  // 이 학습 폴더로 만드는 중인 세트(맞춤 퀴즈 · 앞서 만든 유사 퀴즈 등)가 있으면 목록을 다시 읽어 끝나는 것을 본다.
  // 만들기는 새 세트가 들어갈 노트(noteOf)로 만드는 중일 때만 막는다(서버 고유 색인과 같은 노트 단위, code-review 3차)
  const generatingHere = (list?: QuizSet[]) =>
    !!list?.some((s) => s.status === 'generating' && s.folderId === folderId);
  const sets = useQuery({
    queryKey: ['quiz-sets'],
    queryFn: api.quiz.sets,
    refetchInterval: (q) => (generatingHere(q.state.data) ? 3000 : false),
  });
  const groups = pickableSets(sets.data, folderId);
  // 체크를 바꾸기 전에는 틀린 문제가 기본 체크다. 한 번 바꾸면 그 뒤로는 사용자가 고른 대로(세트를 다시 읽어도)
  const [picked, setPicked] = useState<string[] | null>(null);
  const [full, setFull] = useState(false);
  // 화면 차례(세트 · 문제 순). 고른 문제는 지금 목록에 있는 것만 센다: 다시 읽은 목록에서 빠진 세트의 문제는
  // 고른 수 · 상한 · 보내기에서 모두 뺀다(code-review)
  const order = groups.flatMap((s) => s.questions.map((q) => q._id));
  const chosen = (picked ?? defaultPicks(groups)).filter((id) => order.includes(id));
  // 서버로 보낼 차례(화면 차례: 세트 · 문제 순). 노트 판단(noteOf)도 이 차례로 해야 서버와 같은 노트를 고른다
  // (같은 수일 때 먼저 고른 쪽, Codex 1차)
  const ordered = order.filter((id) => chosen.includes(id));
  const making = useSimilarMaking((ids: string[]) => api.quiz.similarPick(ids));
  // 결과 확인에 실패했을 때(checkFailed)도 체크를 막는다: 그때 버튼은 이미 넣은 세트를 다시 확인할 뿐이다
  const busy = making.generate.isPending || making.waiting || making.checkFailed;
  const note = noteOf(ordered, groups);
  const blocked =
    !making.generate.data &&
    !!sets.data?.some((s) => s.status === 'generating' && !!note && s.materialId === note);
  const toggle = (q: Question) => {
    if (chosen.includes(q._id)) {
      setFull(false);
      setPicked(chosen.filter((id) => id !== q._id));
    } else if (chosen.length >= SIMILAR_PICK_MAX) {
      setFull(true);
    } else {
      setPicked([...chosen, q._id]);
    }
  };
  // 고른 차례가 아니라 화면 차례(세트 · 문제 순)로 보낸다
  const send = () => making.generate.mutate(ordered);
  return (
    <Canvas>
      <Screen
        footer={
          <Btn
            loading={making.generate.isPending || making.waiting}
            disabled={!making.checkFailed && (chosen.length === 0 || blocked)}
            onPress={() => (making.checkFailed ? void making.poll.refetch() : send())}
          >
            {making.checkFailed
              ? '다시 확인'
              : blocked
                ? '이 노트로 만드는 중인 퀴즈가 끝나면 만들 수 있어요'
                : making.generate.isError || making.failed
                  ? '다시 시도'
                  : `유사 퀴즈 만들기 · ${chosen.length}문제 골랐어요`}
          </Btn>
        }
      >
        <NetBanner />
        <Header title="유사 퀴즈" sub="어떤 문제와 비슷한 문제를 풀까요?" large={false} />
        <Text className="text-caption text-sub">
          마지막에 틀린 문제를 골라 뒀어요. 고른 문제를 함께 참고해 비슷한 문제 3개를 만들어요.
        </Text>
        {full && (
          <Text className="mt-2 text-caption text-danger">
            한 번에 최대 {SIMILAR_PICK_MAX}문제까지 고를 수 있어요
          </Text>
        )}
        <SimilarStatus s={making} />
        {sets.isPending && (
          <View accessible accessibilityLabel="퀴즈를 불러오는 중">
            <Loading />
          </View>
        )}
        {sets.isError && !sets.data && (
          <Empty
            icon={<Sparkles size={ICON.lg} color={C.brand} />}
            title="퀴즈를 불러오지 못했어요"
            body="연결을 확인하고 다시 시도해 주세요."
          >
            <Btn small loading={sets.isFetching} onPress={() => void sets.refetch()}>
              다시 시도
            </Btn>
          </Empty>
        )}
        {sets.isSuccess && groups.length === 0 && (
          <Empty
            icon={<Sparkles size={ICON.lg} color={C.brand} />}
            title="이 노트에서 끝까지 푼 퀴즈가 없어요"
            body="이 노트로 퀴즈를 풀고 나면 그 문제로 유사 퀴즈를 만들 수 있어요."
          />
        )}
        {groups.map((s) => (
          <View key={s._id}>
            <Label>{s.title}</Label>
            <Group>
              {s.questions.map((q) => {
                const on = chosen.includes(q._id);
                const wrong = (s.wrongQuestionIds ?? []).includes(q._id);
                return (
                  <Pressable
                    key={q._id}
                    accessibilityRole="checkbox"
                    accessibilityLabel={`유사 퀴즈 고르기 ${q.prompt}`}
                    accessibilityState={{ checked: on, disabled: busy }}
                    disabled={busy}
                    onPress={() => toggle(q)}
                    scaleTo={1}
                    className="min-h-14 flex-row items-center gap-3.5 px-5 py-4 active:bg-black/5"
                  >
                    <Box on={on} />
                    <View className="flex-1">
                      <Text className="text-callout text-ink" numberOfLines={3}>
                        {q.prompt}
                      </Text>
                      {wrong && (
                        <Text className="mt-0.5 text-caption text-danger">지난번에 틀림</Text>
                      )}
                    </View>
                  </Pressable>
                );
              })}
            </Group>
          </View>
        ))}
      </Screen>
    </Canvas>
  );
}
