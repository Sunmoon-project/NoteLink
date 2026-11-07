import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Text } from '@/components/text';
import Animated, {
  FadeIn,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Speech from 'expo-speech';
import * as Haptics from 'expo-haptics';
import {
  Archive,
  ArrowLeft,
  Brain,
  CircleCheck,
  FileText,
  Layers,
  PartyPopper,
  PenLine,
  Plus,
  Sparkles,
  Volume2,
  X,
} from 'lucide-react-native';
import { ERROR_CODES, type AiJob, type Question } from '@notelink/shared';
import { api, ApiError } from '@/lib/api';
import { useFeatureNavigation } from '@/lib/feature-navigation';
import { socket } from '@/lib/socket';
import { useSocket } from '@/hooks';
import { useQuizProgress } from '@/stores/quiz-progress';
import { useAuth } from '@/stores/auth';
import { useNet } from '@/stores/net';
import { toast } from '@/stores/toast';
import {
  Header,
  Alert,
  Badge,
  Btn,
  Canvas,
  Card,
  Loading,
  Progress,
  Screen,
  Search,
  Tap,
  Title,
  cx,
} from '@/components/ui';
import { NetBanner } from '@/components/NetBanner';
import { C, ICON } from '@/theme';
import { seoul } from '@/lib/dates';
import { aiWaiting } from '@/lib/ai';
import { AiPending } from '@/components/AiPending';

// p.85~89 퀴즈 · 플래시카드 · 퀴즈 보관함

/** 오답 표시를 좌우로 두 번 살짝 흔든다. 동작 줄이기면 흔들지 않는다 */
function Shake({ on, children }: { on: boolean; children: React.ReactNode }) {
  const x = useSharedValue(0);
  useEffect(() => {
    if (!on) return;
    const t = { duration: 60, reduceMotion: ReduceMotion.System };
    x.set(withSequence(withTiming(4, t), withTiming(-4, t), withTiming(4, t), withTiming(0, t)));
  }, [on, x]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }] }));
  return <Animated.View style={style}>{children}</Animated.View>;
}

const Tutor = ({ size = 76 }: { size?: number }) => (
  <View
    accessibilityLabel="AI 튜터"
    className="items-center justify-center self-center rounded-full bg-peach"
    style={{ width: size, height: size }}
  >
    <Text style={{ fontSize: size * 0.58 }}>🧑🏻</Text>
  </View>
);

export function QuizHomeScreen() {
  const sets = useQuery({ queryKey: ['quiz-sets'], queryFn: api.quiz.sets });
  const progress = useQuizProgress((s) => s.progress);
  const latest = progress
    ? (sets.data?.find((s) => s._id === progress.setId) ?? {
        _id: progress.setId,
        title: '풀던 퀴즈',
        questionCount: 0,
      })
    : sets.data?.find((s) => s.status === 'ready');
  const waiting = sets.data?.filter((s) => s.status === 'generating') ?? [];
  return (
    <Canvas>
      <Screen>
        <NetBanner />
        <Title>학습 퀴즈</Title>
        {waiting.length > 0 && (
          <View className="mt-4">
            <AiPending
              what={`퀴즈 ${waiting.length}개 생성`}
              hint={waiting.map((w) => w.title).join(' · ')}
            />
          </View>
        )}
        {latest ? (
          <>
            <Card
              tone="mint"
              onPress={() =>
                router.push({ pathname: '/play/solve', params: { setId: latest._id } })
              }
              className="mt-1 p-5"
            >
              <Text className="text-caption text-sub">
                {progress ? '이어서 풀기' : '퀴즈 풀기'}
              </Text>
              <Text className="text-body font-bold text-ink">
                {latest.title}
                {latest.questionCount > 0 ? ` · ${latest.questionCount}문제` : ''}
              </Text>
              {!!progress && latest.questionCount > 0 && (
                <Progress
                  value={Math.round((progress.index / latest.questionCount) * 100)}
                  className="mt-2"
                />
              )}
            </Card>
            <View className="mt-4 flex-row flex-wrap justify-between gap-y-3">
              {(
                [
                  [PenLine, '퀴즈 만들기', '/(tabs)/quiz/notes'],
                  [Layers, '플래시 카드', '/play/flash'],
                  [Archive, '퀴즈 보관함', '/play/box'],
                  [Sparkles, '유사 퀴즈', '/play/similar'],
                ] as const
              ).map(([Ic, l, href]) => (
                <Card
                  key={l}
                  onPress={() =>
                    router.push({ pathname: href as never, params: { setId: latest._id } })
                  }
                  className="w-[48%] gap-4 p-5"
                >
                  <View className="h-10 w-10 items-center justify-center rounded-xl bg-mint">
                    <Ic size={ICON.md} color={C.brand} />
                  </View>
                  <Text className="text-subhead font-semibold text-ink">{l}</Text>
                </Card>
              ))}
            </View>
          </>
        ) : (
          sets.isSuccess && (
            <View className="items-center pt-24">
              <View className="h-24 w-24 items-center justify-center rounded-full bg-cream">
                <Brain size={ICON.xl} color={C.brand} />
              </View>
              <Text className="mt-5 text-body font-bold text-ink">아직 만들어진 퀴즈가 없어요</Text>
              <Text className="text-caption text-sub">
                노트를 업로드하면 자동으로 퀴즈가 생성돼요
              </Text>
              <Btn small className="mt-5 w-56" onPress={() => router.push('/(tabs)/quiz/notes')}>
                노트 업로드하고 퀴즈 만들기
              </Btn>
            </View>
          )
        )}
        {sets.isError && <ErrorAlert retry={() => sets.refetch()} />}
      </Screen>
    </Canvas>
  );
}

/** p.97 알 수 없는 오류 — 대화상자를 닫아도 화면에 다시 시도할 길을 남긴다 */
function ErrorAlert({ retry }: { retry: () => void }) {
  const [open, setOpen] = useState(true);
  if (!open)
    return (
      <View className="items-center gap-3 py-12">
        <Text className="text-center text-footnote text-sub">내용을 불러오지 못했어요</Text>
        <Btn small onPress={retry}>
          다시 불러오기
        </Btn>
      </View>
    );
  return (
    <Alert
      open
      title="문제가 생겼어요"
      body={`잠시 후 다시 시도해 주세요.\n작성한 내용은 그대로 보관돼 있어요.`}
      secondary="닫기"
      onSecondary={() => setOpen(false)}
      primary="다시 시도"
      onPrimary={() => {
        setOpen(false);
        retry();
      }}
    />
  );
}

/** 퀴즈는 노트(자료) 하나로 만든다 (FR-38-02) — 폴더마다 정리가 끝난 자료를 모은다 */
async function quizNotes() {
  const folders = await api.content.folders();
  const lists = await Promise.all(
    folders.map(async (f) =>
      (await api.content.materials(f._id))
        .filter((m) => !m.processing || m.processing.status === 'done')
        .map((m) => ({ ...m, subjectName: f.subjectName })),
    ),
  );
  return lists.flat();
}

export function QuizNotesScreen() {
  const openFeature = useFeatureNavigation();
  const notes = useQuery({ queryKey: ['quiz-notes'], queryFn: quizNotes });
  const [picked, setPicked] = useState<string | null>(null);
  const offline = useNet((s) => s.state === 'offline');
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState(false);
  const list = (notes.data ?? []).filter((f) => f.title.includes(q));
  const chosen = list.find((f) => f._id === picked);
  const make = () =>
    chosen
      ? router.push({
          pathname: '/play/gen',
          params: { materialId: chosen._id, title: chosen.title },
        })
      : toast('퀴즈를 만들 노트를 먼저 골라 주세요');
  return (
    <View className="flex-1 bg-white">
      <Screen footer={chosen ? <Btn onPress={make}>이 노트로 퀴즈 만들기</Btn> : undefined}>
        <NetBanner />
        <Header title="어떤 노트로 퀴즈를 만들까요?" large={false} />
        <Search value={q} onChangeText={setQ} placeholder="노트 검색" />
        {notes.isError && !notes.data && <ErrorAlert retry={() => notes.refetch()} />}
        {notes.isSuccess && notes.data.length === 0 && (
          <View className="items-center py-16">
            <Text className="text-footnote text-sub">아직 노트가 없어요</Text>
            <Btn
              small
              className="mt-4 w-44"
              onPress={() => openFeature('/(tabs)/note', 'navigate', '/capture/picked')}
            >
              노트 올리러 가기
            </Btn>
          </View>
        )}
        <View className="mt-3 flex-row flex-wrap justify-between gap-y-3">
          {list.map((f) => (
            <Card
              key={f._id}
              tone="mint"
              onPress={() =>
                offline
                  ? toast('연결되면 퀴즈를 만들 수 있어요 · 노트는 그대로 볼 수 있어요')
                  : setPicked(f._id)
              }
              className={cx('w-[48.5%] p-2.5', picked === f._id && 'border-2 border-blue')}
            >
              <View className="h-16 items-center justify-center rounded-xl bg-white">
                <FileText size={ICON.lg} color={C.brand} />
              </View>
              <Text className="mt-2 px-1 text-footnote font-semibold text-ink">{f.title}</Text>
              <Text className="px-1 text-caption2 text-sub">
                {f.subjectName} · {seoul(f.createdAt).getMonth() + 1}/{seoul(f.createdAt).getDate()}
              </Text>
            </Card>
          ))}
        </View>
        {offline && (
          <View className="mt-6 rounded-full bg-mint py-2.5">
            <Text className="text-center text-caption font-semibold text-brand">
              저장된 노트는 그대로 볼 수 있어요
            </Text>
          </View>
        )}
      </Screen>
      {menu && (
        <View className="absolute inset-0 z-20">
          <Pressable className="absolute inset-0 bg-black/45" onPress={() => setMenu(false)} />
          <View
            className={cx('absolute right-5 items-end gap-3', chosen ? 'bottom-44' : 'bottom-24')}
          >
            {(
              [
                ['플래시 카드', Layers, () => router.push('/play/flash')],
                ['퀴즈 보관함', Archive, () => router.push('/play/box')],
                [
                  '새 노트 올리고 만들기',
                  FileText,
                  () => openFeature('/(tabs)/note', 'navigate', '/capture/picked'),
                ],
                ['퀴즈 만들기', PenLine, make],
              ] as const
            ).map(([l, Ic, fn], i) => (
              <Animated.View key={l} entering={FadeInDown.duration(180).delay(i * 30)}>
                <Pressable
                  onPress={() => {
                    setMenu(false);
                    fn();
                  }}
                  className="flex-row items-center gap-2"
                >
                  <View className="rounded-full bg-ink px-3 py-1.5">
                    <Text className="text-footnote font-semibold text-white">{l}</Text>
                  </View>
                  <View className="h-11 w-11 items-center justify-center rounded-full bg-white shadow">
                    <Ic size={ICON.md} color={C.brand} />
                  </View>
                </Pressable>
              </Animated.View>
            ))}
          </View>
        </View>
      )}
      <Pressable
        accessibilityLabel={menu ? '닫기' : '메뉴'}
        onPress={() => setMenu((m) => !m)}
        className={cx(
          'absolute right-5 z-30 h-14 w-14 items-center justify-center rounded-full shadow-lg',
          chosen ? 'bottom-24' : 'bottom-5',
          menu ? 'bg-ink' : 'border border-line bg-white',
        )}
      >
        {menu ? <X size={ICON.lg} color="#fff" /> : <Plus size={ICON.lg} color={C.ink} />}
      </Pressable>
    </View>
  );
}

export function QuizGenScreen() {
  const { materialId, title } = useLocalSearchParams<{
    materialId: string;
    title?: string;
  }>();
  const qc = useQueryClient();
  const [job, setJob] = useState<AiJob | null>(null);
  const [setId, setSetId] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [failureMessage, setFailureMessage] = useState('');
  const canceled = useRef(false);
  const activeJob = useRef<string | null>(null);
  const completedJob = useRef<string | null>(null);
  useEffect(() => {
    let disposed = false;
    canceled.current = false;
    api.quiz
      .createSet(materialId)
      .then((r) => {
        if (disposed || canceled.current) {
          api.ai.cancel(r.job._id).catch(() => toast('생성 취소를 확인하지 못했어요'));
          return;
        }
        activeJob.current = r.job._id;
        setJob(r.job);
        setSetId(r.quizSet._id);
        socket.emit('ai:subscribe', { jobId: r.job._id });
      })
      .catch((e) => {
        if (!disposed && !canceled.current) {
          setFailed(e instanceof ApiError ? e.code : 'NETWORK');
          setFailureMessage(e instanceof Error ? e.message : '문제를 생성하지 못했어요');
        }
      });
    return () => {
      disposed = true;
    };
  }, [materialId]);
  useSocket(
    'ai:progress',
    (p) => p.jobId === job?._id && setJob((j) => (j ? { ...j, progress: p.progress } : j)),
    [job?._id],
  );
  const acceptJob = (done: AiJob) => {
    if (canceled.current || done._id !== activeJob.current || completedJob.current === done._id)
      return;
    if (!['succeeded', 'failed', 'canceled'].includes(done.status)) return;
    completedJob.current = done._id;
    qc.invalidateQueries({ queryKey: ['quiz-sets'] });
    if (done.status === 'succeeded' && setId)
      router.replace({ pathname: '/play/ready', params: { setId, title } });
    else setFailed(done.error ?? 'FAILED');
  };
  useSocket('ai:done', ({ job }) => acceptJob(job), [job?._id, setId]);
  useEffect(() => {
    if (!job?._id || !setId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const checkStatus = async () => {
      if (!active || canceled.current || completedJob.current === job._id) return;
      try {
        if (useNet.getState().state === 'offline') return;
        const current = await api.ai.job(job._id);
        if (active) {
          setJob(current);
          acceptJob(current);
        }
      } catch {
        /* 일시적인 조회 실패는 다음 검사에서 복구한다. */
      } finally {
        if (active && !canceled.current && completedJob.current !== job._id)
          timer = setTimeout(() => void checkStatus(), 1500);
      }
    };
    void checkStatus();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [job?._id, setId]); // eslint-disable-line react-hooks/exhaustive-deps
  const credit = failed === ERROR_CODES.AI_CREDIT_EXHAUSTED;
  const partial = useQuery({
    queryKey: ['quiz-set', setId],
    queryFn: () => api.quiz.set(setId!),
    enabled: credit && !!setId,
  });
  const count = credit && setId ? (partial.data?.questions.length ?? 0) : 0;
  const pct = job?.progress ?? 0;
  // AI 서버가 없으면 생성을 대기열에 두고 돌아간다 (FR-65-05)
  if (aiWaiting(job))
    return (
      <Screen
        footer={
          <Btn
            onPress={() => {
              qc.invalidateQueries({ queryKey: ['quiz-sets'] });
              router.dismissTo('/(tabs)/quiz');
            }}
          >
            퀴즈 탭으로
          </Btn>
        }
      >
        <View className="pt-24">
          <AiPending
            what={`'${title}' 퀴즈 생성`}
            hint="노트 내용을 분석해 5문제를 만드는 일은 AI 서버가 해요. 연결되면 자동으로 만들어져요."
          />
        </View>
      </Screen>
    );
  return (
    <View className="flex-1">
      <Screen>
        <View className="items-end pt-3">
          <Pressable
            onPress={() => {
              canceled.current = true;
              if (activeJob.current)
                api.ai
                  .cancel(activeJob.current)
                  .catch(() => toast('생성 취소를 확인하지 못했어요'));
              router.back();
            }}
            className="rounded-full border border-danger/30 px-3 py-1"
          >
            <Text className="text-footnote text-danger">취소</Text>
          </Pressable>
        </View>
        <View className="items-center pt-32">
          <View className="h-20 w-20 items-center justify-center rounded-full bg-sun/25">
            <Brain size={ICON.xl} color={C.brand} />
          </View>
          <Text className="mt-5 text-callout font-bold text-ink">문제를 생성하고 있어요</Text>
          <Text className="text-caption text-sub">노트 내용을 분석해서 퀴즈를 만드는 중이에요</Text>
          <Progress value={pct} className="mt-5 w-40" />
          <Text className="mt-2 text-caption2 text-sub">{pct}%</Text>
        </View>
      </Screen>
      <Alert
        open={credit}
        tone="sun"
        title={'이번 달 AI 크레딧을\n모두 사용했어요'}
        body={
          count > 0
            ? `${count}개 문제를 만들었어요. 갱신 후 이어서 만들 수 있어요.`
            : failureMessage || '크레딧이 부족해 문제를 생성하지 못했어요.'
        }
        secondary={count > 0 ? '나중에' : undefined}
        onSecondary={() => router.back()}
        primary={count > 0 ? '만든 문제 보기' : '돌아가기'}
        onPrimary={() => {
          if (setId && count > 0) router.replace({ pathname: '/play/solve', params: { setId } });
          else router.back();
        }}
      />
      <Alert
        open={!!failed && !credit}
        title="문제를 만들지 못했어요"
        body="노트는 그대로 있어요. 잠시 후 다시 시도해 주세요."
        secondary="닫기"
        onSecondary={() => router.back()}
        primary="다시 시도"
        onPrimary={() => router.replace({ pathname: '/play/gen', params: { materialId, title } })}
      />
    </View>
  );
}

export function QuizReadyScreen() {
  const { setId, title } = useLocalSearchParams<{ setId: string; title?: string }>();
  // 문제 수는 서버가 만든 실제 값을 보여 준다. 못 읽으면 숫자 없이 안내한다
  const set = useQuery({ queryKey: ['quiz-set', setId], queryFn: () => api.quiz.set(setId) });
  const count = set.data?.questionCount;
  return (
    <Screen
      footer={
        <>
          <Btn onPress={() => router.replace({ pathname: '/play/solve', params: { setId } })}>
            퀴즈 시작하기
          </Btn>
          <Pressable
            onPress={() => router.dismissTo('/(tabs)/quiz')}
            className="mt-2 self-center rounded-full border border-line px-3 py-1"
          >
            <Text className="text-caption text-sub">나중에 풀기</Text>
          </Pressable>
        </>
      }
    >
      <View className="items-center pt-40">
        <Animated.View
          entering={FadeIn}
          className="h-20 w-20 items-center justify-center rounded-full bg-mint"
        >
          <CircleCheck size={ICON.xl} color={C.brand} />
        </Animated.View>
        <Text className="mt-5 text-headline font-bold text-ink">
          {count ? `총 ${count}문제가 생성됐어요!` : '문제가 생성됐어요!'}
        </Text>
        {!!title && (
          <Text className="text-caption text-sub">{title} 노트를 기반으로 만들었어요</Text>
        )}
      </View>
    </Screen>
  );
}

export function QuizSolveScreen() {
  const { setId, from } = useLocalSearchParams<{ setId?: string; from?: string }>();
  const [previous] = useState(() => {
    const saved = useQuizProgress.getState().progress;
    return saved && (!setId || saved.setId === setId) ? saved : null;
  });
  const activeSetId = setId ?? previous?.setId;
  const set = useQuery({
    queryKey: ['quiz-set', activeSetId ?? 'latest'],
    queryFn: () => api.quiz.set(activeSetId ?? ''),
  });
  const [attemptId, setAttemptId] = useState<string | null>(previous?.attemptId ?? null);
  const [startError, setStartError] = useState(false);
  const [answerText, setAnswerText] = useState(previous?.answerText ?? '');
  const answering = useRef(false);
  const mounted = useRef(true);
  const screenGeneration = useRef(useQuizProgress.getState().generation);
  const [screenOwner] = useState(() => useAuth.getState().userId);
  const ownsProgress = useCallback(
    () =>
      mounted.current &&
      useAuth.getState().userId === screenOwner &&
      useQuizProgress.getState().generation === screenGeneration.current,
    [screenOwner],
  );
  useEffect(() => {
    mounted.current = true;
    screenGeneration.current = useQuizProgress.getState().claim();
    return () => {
      mounted.current = false;
    };
  }, []);
  const [startRound, setStartRound] = useState(0);
  const [i, setI] = useState(previous?.index ?? 0);
  const [pick, setPick] = useState<string | null>(previous?.right == null ? null : previous.pick);
  const [right, setRight] = useState<boolean | null>(previous?.right ?? null);
  const [results, setResults] = useState<boolean[]>(previous?.results ?? []);
  const [speaking, setSpeaking] = useState(false);
  const expired = useAuth((s) => s.expired);
  const finishing = useRef(false);
  const completionKey = ['quiz-finish', screenOwner, attemptId];
  const completing = useIsMutating({ mutationKey: completionKey }) > 0;
  const finish = useMutation({
    mutationKey: completionKey,
    mutationFn: (request: {
      owner: string | null;
      attemptGeneration: number;
      setId: string;
      attemptId: string;
    }) => api.quiz.finish(request.attemptId),
    // 완료는 포인트를 적립하므로 응답 유실 시 자동으로 재전송하지 않는다.
    retry: false,
    onSuccess: (r, request) => {
      const state = useQuizProgress.getState();
      if (
        useAuth.getState().userId !== request.owner ||
        state.attemptGeneration !== request.attemptGeneration ||
        state.progress?.setId !== request.setId ||
        state.progress.attemptId !== request.attemptId
      )
        return;
      // 화면을 떠나도 같은 풀이의 완료 응답은 보존하고 재진입 화면이 결과를 연다.
      state.save({ ...state.progress, completed: r });
    },
    onError: (e, request) => {
      const state = useQuizProgress.getState();
      if (
        useAuth.getState().userId !== request.owner ||
        state.attemptGeneration !== request.attemptGeneration ||
        state.progress?.setId !== request.setId ||
        state.progress.attemptId !== request.attemptId
      )
        return;
      if (e instanceof ApiError && e.code === ERROR_CODES.TOKEN_EXPIRED)
        useAuth.getState().setExpired(true);
      toast('완료 결과를 저장하지 못했어요. 다시 시도해 주세요');
    },
    onSettled: () => {
      finishing.current = false;
    },
  });

  useEffect(() => {
    let active = true;
    if (set.data && !attemptId)
      api.quiz
        .startAttempt(set.data._id)
        .then((a) => {
          if (active && ownsProgress()) setAttemptId(a._id);
        })
        .catch(() => {
          if (active && ownsProgress()) setStartError(true);
        });
    return () => {
      active = false;
    };
  }, [set.data?._id, startRound]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      Speech.stop();
    },
    [],
  );
  useEffect(() => {
    if (set.data && !finish.isSuccess && ownsProgress()) {
      useQuizProgress
        .getState()
        .save({ setId: set.data._id, attemptId, index: i, answerText, pick, right, results });
      screenGeneration.current = useQuizProgress.getState().generation;
    }
  }, [set.data, attemptId, i, answerText, pick, right, results, finish.isSuccess, ownsProgress]);
  const completedSetId = set.data?._id ?? activeSetId;
  const completed = useQuizProgress((state) =>
    state.progress?.setId === completedSetId ? state.progress?.completed : undefined,
  );
  useEffect(() => {
    if (!completed || !completedSetId || !ownsProgress() || !attemptId) return;
    useQuizProgress.getState().reset();
    router.replace({
      pathname: '/play/review',
      params: { setId: completedSetId, points: String(completed.pointsEarned) },
    });
  }, [completed, attemptId, completedSetId, ownsProgress]);
  if (set.isError && !set.data)
    return (
      <Screen>
        <Text>퀴즈를 불러오지 못했어요</Text>
        <Btn onPress={() => set.refetch()}>다시 시도</Btn>
      </Screen>
    );
  if (!set.data) return <Loading />;
  const qs = set.data.questions;
  const q = qs[i];
  // 문제가 없거나 저장된 위치가 어긋나면 로딩에 갇히지 않게 나갈 길을 준다
  if (!q)
    return (
      <Screen>
        <Text className="pt-8 text-center text-body text-ink">풀 수 있는 문제가 없어요</Text>
        <Btn
          className="mt-4"
          onPress={() => {
            if (ownsProgress()) useQuizProgress.getState().reset();
            router.back();
          }}
        >
          돌아가기
        </Btn>
      </Screen>
    );
  const speak = () => {
    if (speaking) {
      Speech.stop();
      return setSpeaking(false);
    }
    setSpeaking(true);
    Speech.speak(`${q.prompt}. ${(q.choices ?? []).map((c, n) => `${n + 1}번, ${c}`).join('. ')}`, {
      language: 'ko-KR',
      onDone: () => setSpeaking(false),
      onStopped: () => setSpeaking(false),
    });
  };
  const choose = async (c: string) => {
    if (!ownsProgress()) return toast('다른 풀이를 진행 중이에요. 풀던 퀴즈를 다시 열어주세요');
    if (answering.current || pick || !attemptId || !c.trim()) return;
    answering.current = true;
    setPick(c);
    try {
      const r = await api.quiz.answer(attemptId, q._id, c);
      if (!ownsProgress()) return;
      setRight(r.correct);
      setResults((x) => [...x, r.correct]);
      Haptics.notificationAsync(
        r.correct
          ? Haptics.NotificationFeedbackType.Success
          : Haptics.NotificationFeedbackType.Error,
      );
    } catch (e) {
      if (!ownsProgress()) return;
      // 로그인 만료: 풀던 내용은 그대로 두고 다이얼로그 (p.101)
      if (e instanceof ApiError && e.code === ERROR_CODES.TOKEN_EXPIRED)
        useAuth.getState().setExpired(true);
      setPick(null);
      toast('답안을 저장하지 못했어요. 다시 시도해주세요');
    } finally {
      answering.current = false;
    }
  };
  const next = () => {
    if (!ownsProgress()) return toast('다른 풀이를 진행 중이에요. 풀던 퀴즈를 다시 열어주세요');
    if (finishing.current || completing) return;
    if (i >= qs.length - 1) {
      const progress = useQuizProgress.getState().progress;
      if (!attemptId || progress?.attemptId !== attemptId || progress.setId !== set.data?._id) {
        toast('현재 풀이와 저장된 진행이 달라요. 풀던 퀴즈를 다시 열어주세요');
        return;
      }
      finishing.current = true;
      finish.mutate({
        owner: useAuth.getState().userId,
        attemptGeneration: useQuizProgress.getState().attemptGeneration,
        setId: set.data._id,
        attemptId,
      });
      return;
    }
    setI((x) => x + 1);
    setAnswerText('');
    setPick(null);
    setRight(null);
  };
  const retry = () => {
    if (!ownsProgress()) return toast('다른 풀이를 진행 중이에요. 풀던 퀴즈를 다시 열어주세요');
    setPick(null);
    setRight(null);
    setResults((r) => r.slice(0, -1));
  };
  return (
    <Canvas>
      <Screen
        footer={
          pick === null ? (
            <Btn kind="cream" icon={<Volume2 size={ICON.sm} color={C.ink} />} onPress={speak}>
              {speaking ? '읽어주는 중… (탭해서 멈춤)' : '음성으로 듣기'}
            </Btn>
          ) : right ? (
            <Btn loading={finish.isPending || completing} onPress={next}>
              다음 문제 풀기
            </Btn>
          ) : right === false ? (
            <View className="gap-2">
              <Btn kind="cream" disabled={finish.isPending || completing} onPress={retry}>
                다시 풀기
              </Btn>
              <Btn loading={finish.isPending || completing} onPress={next}>
                다음 문제 풀기
              </Btn>
            </View>
          ) : (
            <Btn loading>채점 중</Btn>
          )
        }
      >
        {startError && (
          <View className="gap-2 py-3">
            <Text>퀴즈를 시작하지 못했어요</Text>
            <Btn
              onPress={() => {
                if (!ownsProgress()) return toast('풀던 퀴즈를 다시 열어주세요');
                setStartError(false);
                setStartRound((n) => n + 1);
              }}
            >
              다시 시작
            </Btn>
          </View>
        )}
        {from === 'room' && (
          <Pressable onPress={() => router.back()} className="mt-3 flex-row items-center gap-2">
            <ArrowLeft size={ICON.sm} color={C.ink} />
            <Text className="text-footnote text-ink">스터디룸으로</Text>
          </Pressable>
        )}
        <Progress value={((i + (right === null ? 0 : 1)) / qs.length) * 100} className="mt-5" />
        <Text className="pt-4 text-center text-caption text-sub">
          복습 퀴즈 {i + 1} / {qs.length}
        </Text>
        <View className="mt-4">
          <Tutor size={pick === null ? 76 : 70} />
        </View>
        {pick === null || right === null ? (
          <Animated.View entering={FadeIn}>
            <Text className="mt-7 text-callout leading-6 font-bold text-ink">{q.prompt}</Text>
            <View className="mt-5 gap-3">
              {(!q.choices || q.choices.length === 0) && (
                <>
                  <TextInput
                    value={answerText}
                    onChangeText={(value) => {
                      if (ownsProgress()) setAnswerText(value);
                    }}
                    placeholder="답을 입력해주세요"
                    editable={!!attemptId && pick === null}
                    className="rounded-xl bg-white p-3"
                  />
                  <Btn
                    disabled={!attemptId || !answerText.trim() || pick !== null}
                    onPress={() => choose(answerText.trim())}
                  >
                    답 제출
                  </Btn>
                </>
              )}
              {(q.choices ?? []).map((c, n) => (
                <Tap
                  key={c}
                  onPress={() => choose(c)}
                  className={cx(
                    'min-h-14 justify-center rounded-2xl px-5 py-4',
                    pick === c ? 'bg-mint' : 'bg-white',
                  )}
                >
                  <Text className="text-subhead text-ink">
                    {'①②③④⑤'[n]} {c}
                  </Text>
                </Tap>
              ))}
            </View>
          </Animated.View>
        ) : (
          <Animated.View entering={FadeIn}>
            {/* 정답은 채워지며 체크, 오답은 좌우로 살짝 흔들림 (240ms · 4px × 2) */}
            <Shake on={!right}>
              <View
                className={cx(
                  'mt-8 flex-row items-center justify-center gap-1.5 rounded-xl py-2.5',
                  right ? 'bg-correct-soft' : 'bg-danger/10',
                )}
              >
                {right ? (
                  <CircleCheck size={ICON.sm} color="#fff" />
                ) : (
                  <X size={ICON.sm} color={C.danger} />
                )}
                <Text
                  className={cx(
                    'text-footnote font-semibold',
                    right ? 'text-white' : 'text-danger',
                  )}
                >
                  {right ? '정답이에요' : '오답이에요, 다시 풀어보세요'}
                </Text>
              </View>
            </Shake>
            {!right && (
              <Text className="mt-3 text-center text-caption text-sub">내가 고른 답: {pick}</Text>
            )}
            <View className="mt-6 flex-row items-center justify-center gap-2">
              <Text className="text-footnote text-sub">결과</Text>
              {qs.map((_, n) => (
                <View
                  key={n}
                  className={cx(
                    'h-3 w-3 rounded-full',
                    n < results.length ? (results[n] ? 'bg-correct' : 'bg-danger') : 'bg-cream-2',
                  )}
                />
              ))}
            </View>
          </Animated.View>
        )}
      </Screen>
      <Alert
        open={expired}
        title="로그인이 만료됐어요"
        body={`풀던 퀴즈는 저장돼 있어요.\n로그인하면 이어서 풀 수 있어요.`}
        secondary="나중에"
        onSecondary={() => useAuth.getState().setExpired(false)}
        primary="다시 로그인"
        onPrimary={() => {
          useAuth.getState().setExpired(false);
          router.push('/(auth)/login');
        }}
      />
    </Canvas>
  );
}

export function QuizReviewScreen() {
  const { setId, points } = useLocalSearchParams<{ setId?: string; points?: string }>();
  const set = useQuery({
    queryKey: ['quiz-set', setId ?? 'latest'],
    queryFn: () => api.quiz.set(setId ?? ''),
  });
  const qc = useQueryClient();
  const [reward, setReward] = useState(Number(points) > 0);
  const [select, setSelect] = useState(false);
  // 선택 모드에서는 문제 하나를 골라 AI 설명을 본다 (FR-52-01 ~ 05)
  const [sel, setSel] = useState<string | null>(null);
  const storeInBox = useMutation({
    mutationFn: (questionIds: string[]) => api.quiz.saveToBox(questionIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['quiz-box'] });
      setSel(null);
      setSelect(false);
      toast('퀴즈 보관함에 저장했어요');
    },
    onError: () => toast('보관함에 저장하지 못했어요. 다시 시도해 주세요'),
  });
  useEffect(() => {
    if (points) qc.invalidateQueries({ queryKey: ['me'] });
  }, [points]); // eslint-disable-line react-hooks/exhaustive-deps
  const qs = set.data?.questions ?? [];
  if (set.isError && !set.data)
    return (
      <Screen>
        <Text>완료한 퀴즈를 불러오지 못했어요</Text>
        <Btn loading={set.isFetching} onPress={() => void set.refetch()}>
          다시 시도
        </Btn>
        <Btn kind="outline" onPress={() => router.back()}>
          뒤로
        </Btn>
      </Screen>
    );
  if (!set.data) return <Loading />;
  return (
    <View className="flex-1">
      <Screen
        footer={
          <>
            {select ? (
              <View className="gap-2">
                <Btn
                  disabled={!sel}
                  loading={storeInBox.isPending}
                  onPress={() => sel && storeInBox.mutate([sel])}
                >
                  보관함에 저장
                </Btn>
                <Btn
                  disabled={!sel}
                  onPress={() =>
                    sel &&
                    router.push({
                      pathname: '/play/explain',
                      params: { qid: sel, setId: set.data._id },
                    })
                  }
                >
                  AI 설명 보기
                </Btn>
              </View>
            ) : (
              <Btn onPress={() => router.dismissTo('/(tabs)/quiz')}>확인</Btn>
            )}
            <Pressable
              onPress={() => router.push({ pathname: '/play/similar', params: { setId } })}
              className="mt-2 self-center rounded-full border border-line px-3 py-1"
            >
              <Text className="text-caption text-sub">유사 퀴즈 생성하기</Text>
            </Pressable>
          </>
        }
      >
        <View className="items-end pt-3">
          <Pressable
            onPress={() => {
              setSelect((x) => !x);
              setSel(null);
            }}
            className={cx('rounded-full px-3 py-1', select ? 'bg-ink' : 'border border-line')}
          >
            <Text className={cx('text-caption', select ? 'text-white' : 'text-ink')}>
              {select ? '취소' : '선택'}
            </Text>
          </Pressable>
        </View>
        <View className="mt-3 rounded-xl bg-mint py-2.5">
          <View className="flex-row items-center gap-1.5">
            <PartyPopper size={ICON.xs} color={C.brand} />
            <Text className="text-center text-footnote font-semibold text-ink">
              미션 완료! {qs.length}문제를 모두 풀었어요
            </Text>
          </View>
        </View>
        <View className="mt-3 gap-2">
          {qs.map((q, n) => (
            <Pressable
              key={q._id}
              onPress={() =>
                select
                  ? setSel(q._id)
                  : router.push({
                      pathname: '/play/explain',
                      params: { qid: q._id, setId: set.data._id },
                    })
              }
              className={cx('rounded-2xl bg-cream p-3', sel === q._id && 'border-2 border-brand')}
            >
              <View className="flex-row items-start gap-2">
                <View className="h-5 w-5 items-center justify-center rounded-full bg-brand">
                  <Text className="text-caption2 text-white">{n + 1}</Text>
                </View>
                <Text className="flex-1 text-footnote text-ink">Q. {q.prompt}</Text>
              </View>
              <View className="mt-2 rounded-lg bg-mint px-3 py-2">
                <Text className="text-caption text-brand">A. {q.answer}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      </Screen>
      {reward && (
        <Pressable
          onPress={() => setReward(false)}
          className="absolute inset-0 z-40 items-center justify-center bg-black/55"
        >
          <Tutor size={96} />
          <Text className="mt-4 text-headline font-bold text-white">퀴즈 풀기 성공!</Text>
          <Animated.View entering={FadeIn} className="mt-3 rounded-2xl bg-cream px-10 py-3">
            <Text className="text-headline font-bold text-brand">+{points}P</Text>
          </Animated.View>
          <Text className="mt-6 text-caption2 text-white/60">탭해서 닫기</Text>
        </Pressable>
      )}
    </View>
  );
}

export function QuizExplainScreen() {
  const { qid, setId } = useLocalSearchParams<{ qid?: string; setId?: string }>();
  const box = useQuery({ queryKey: ['quiz-box'], queryFn: api.quiz.box, enabled: !setId });
  const source = useQuery({
    queryKey: ['quiz-set', setId],
    queryFn: () => api.quiz.set(setId!),
    enabled: !!setId,
  });
  const q = (setId ? source.data?.questions : box.data)?.find((x) => x._id === qid);
  const ex = useQuery({
    queryKey: ['explain', qid],
    queryFn: () => api.quiz.explanation(qid!),
    enabled: !!q,
  });
  const query = setId ? source : box;
  if (query.isError && !query.data)
    return (
      <Screen>
        <Text>설명할 문제를 불러오지 못했어요</Text>
        <Btn onPress={() => void query.refetch()}>문제 다시 시도</Btn>
        <Btn kind="outline" onPress={() => router.back()}>
          뒤로 가기
        </Btn>
      </Screen>
    );
  if (query.isPending) return <Loading />;
  if (!q)
    return (
      <Screen>
        <Text>문제를 찾을 수 없어요</Text>
        <Btn onPress={() => router.back()}>뒤로 가기</Btn>
      </Screen>
    );
  return (
    <Screen>
      <Pressable
        onPress={() => router.back()}
        className="mt-3 flex-row items-center gap-2 self-start rounded-full border border-line px-3 py-1.5"
      >
        <ArrowLeft size={ICON.sm} color={C.ink} />
        <Text className="text-footnote text-ink">뒤로 가기</Text>
      </Pressable>
      <Text className="mt-4 text-body font-bold text-ink">AI 설명</Text>
      <View className="mt-2 rounded-2xl border border-line">
        <View className="border-b border-ink/80 p-3">
          <Text className="text-caption font-semibold text-brand">문제 {q?.order ?? 1}</Text>
          <Text className="text-subhead text-ink">{q?.prompt}</Text>
        </View>
        <View className="p-3 pt-6">
          {ex.isError && ex.error instanceof ApiError && ex.error.status === 503 ? (
            <AiPending what="AI 풀이 설명" />
          ) : ex.isError ? (
            <View>
              <Text>설명을 불러오지 못했어요</Text>
              <Btn loading={ex.isFetching} onPress={() => void ex.refetch()}>
                설명 다시 시도
              </Btn>
            </View>
          ) : ex.data ? (
            ex.data.text.split('\n').map((l) => (
              <Text
                key={l}
                className={cx('text-footnote leading-6 text-ink', l.startsWith('•') && 'pl-2')}
              >
                {l}
              </Text>
            ))
          ) : (
            <Loading />
          )}
        </View>
      </View>
    </Screen>
  );
}

export function QuizSimilarScreen() {
  const { setId } = useLocalSearchParams<{ setId?: string }>();
  const qc = useQueryClient();
  const cached = useQuery({
    queryKey: ['similar-result', setId],
    queryFn: () => Promise.resolve(null),
    enabled: false,
  });
  const generate = useMutation({
    mutationFn: () => api.quiz.similar(setId ?? ''),
    retry: false,
    onSuccess: (data) => qc.setQueryData(['similar-result', setId], data),
  });
  const sim = {
    data: (cached.data ?? generate.data) as
      Awaited<ReturnType<typeof api.quiz.similar>> | undefined,
  };
  const [open, setOpen] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const saving = useRef(new Set<string>());
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: (q: Question) =>
      api.quiz.saveFlashcard({ front: q.prompt, back: q.answer, sourceQuestionId: q._id }),
    onError: () => toast('카드를 저장하지 못했어요. 다시 시도해주세요'),
    onSettled: (_, __, q) => {
      saving.current.delete(q._id);
      setPendingIds([...saving.current]);
    },
    onSuccess: (_, q) => {
      setSaved((p) => [...p, q._id]);
      // 플래시 카드 화면을 다시 열면 새 카드가 보이게
      qc.invalidateQueries({ queryKey: ['flashcards'] });
      toast('플래시카드에 저장했어요');
    },
  });
  // 문제를 받으면 첫 문제를 펼친다 (렌더 중 상태 조정)
  const [loaded, setLoaded] = useState<typeof sim.data>();
  if (sim.data && sim.data !== loaded) {
    setLoaded(sim.data);
    if (sim.data.questions[0]) setOpen([sim.data.questions[0]._id]);
  }
  return (
    <Screen footer={<Btn onPress={() => router.back()}>확인</Btn>}>
      <Text className="pt-5 text-body font-bold text-ink">유사 퀴즈 생성</Text>
      <Text className="text-caption text-sub">
        {sim.data
          ? `원본과 같은 난이도로 ${sim.data.questionCount}문제를 새로 만들었어요`
          : '원본과 같은 난이도로 새 문제를 만들어요'}
      </Text>
      {!sim.data && (
        <Btn loading={generate.isPending} onPress={() => generate.mutate()}>
          {generate.isError ? '다시 시도' : '유사 퀴즈 만들기'}
        </Btn>
      )}
      {generate.isError && (
        <Text>생성 결과를 받지 못했어요. 다시 시도하면 새 생성 요청을 보내요.</Text>
      )}
      <View className="mt-3 gap-2">
        {sim.data?.questions.map((q, i) => (
          <View key={q._id} className="rounded-2xl border border-line p-3">
            <Text className="text-caption font-semibold text-ink">문제 {i + 1}</Text>
            <Text className="text-footnote text-ink">{q.prompt}</Text>
            {open.includes(q._id) && (
              <Animated.View entering={FadeIn} className="mt-2 rounded-xl bg-sun/25 px-3 py-2">
                <Text className="text-caption font-semibold text-ink">문제 {i + 1} 정답</Text>
                <Text className="text-caption text-ink">{q.answer}</Text>
              </Animated.View>
            )}
            <View className="mt-2 flex-row gap-1.5">
              {!open.includes(q._id) && (
                <Pressable
                  onPress={() => setOpen((p) => [...p, q._id])}
                  className="rounded-full bg-mint px-2.5 py-1"
                >
                  <Text className="text-caption2 text-brand">정답 보기</Text>
                </Pressable>
              )}
              <Pressable
                disabled={saved.includes(q._id) || pendingIds.includes(q._id)}
                onPress={() => {
                  if (saving.current.has(q._id) || saved.includes(q._id)) return;
                  saving.current.add(q._id);
                  setPendingIds([...saving.current]);
                  save.mutate(q);
                }}
                className="rounded-full bg-mint px-2.5 py-1"
              >
                <Text className="text-caption2 text-brand">
                  {saved.includes(q._id) ? '저장됨' : '플래시카드 저장'}
                </Text>
              </Pressable>
            </View>
          </View>
        ))}
      </View>
    </Screen>
  );
}

export function FlashScreen() {
  const { i: start } = useLocalSearchParams<{ i?: string }>();
  const cards = useQuery({ queryKey: ['flashcards'], queryFn: api.quiz.flashcards });
  const [i, setI] = useState(() =>
    Math.max(0, Number.isFinite(Number(start)) ? Math.floor(Number(start)) : 0),
  );
  const [back, setBack] = useState(true);
  const list = cards.data ?? [];
  const index = Math.max(0, Math.min(i, list.length - 1));
  if (cards.isSuccess && i !== index) {
    setI(index);
    setBack(true);
  }
  const c = list[index];
  return (
    <Screen footer={<Btn onPress={() => router.push('/play/cards')}>펼쳐보기</Btn>}>
      <Pressable
        onPress={() => router.back()}
        className="mt-3 flex-row items-center gap-2 self-start rounded-full border border-line px-3 py-1.5"
      >
        <ArrowLeft size={ICON.sm} color={C.ink} />
        <Text className="text-footnote text-ink">뒤로 가기</Text>
      </Pressable>
      {cards.isError && !cards.data && <ErrorAlert retry={() => cards.refetch()} />}
      {cards.isSuccess && list.length === 0 && <Text>저장한 플래시카드가 없어요</Text>}
      {c && (
        <View className="-mx-5 mt-10 bg-mint/70 px-8 py-1">
          <Pressable
            onPress={() => setBack((b) => !b)}
            className="h-72 items-center justify-center rounded-2xl border border-brand/30 bg-white px-6"
          >
            <Animated.Text
              key={`${i}-${back}`}
              entering={FadeIn}
              className="text-center text-body leading-6 font-bold text-ink"
            >
              {back ? c.back : c.front}
            </Animated.Text>
            <Text className="absolute bottom-4 text-caption2 text-sub">탭하여 뒤집기</Text>
          </Pressable>
        </View>
      )}
      <View className="mt-4 flex-row items-center justify-center gap-4">
        <Pressable
          disabled={i === 0}
          onPress={() => {
            setI((x) => x - 1);
            setBack(true);
          }}
          className={i === 0 ? 'opacity-30' : ''}
        >
          <Text className="text-footnote text-sub">‹ 이전</Text>
        </Pressable>
        <Text className="text-footnote text-sub">
          {list.length ? i + 1 : 0} / {list.length}
        </Text>
        <Pressable
          disabled={i >= list.length - 1}
          onPress={() => {
            setI((x) => x + 1);
            setBack(true);
          }}
          className={i >= list.length - 1 ? 'opacity-30' : ''}
        >
          <Text className="text-footnote text-sub">다음 ›</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

export function CardsScreen() {
  const qc = useQueryClient();
  const cards = useQuery({ queryKey: ['flashcards'], queryFn: api.quiz.flashcards });
  const [select, setSelect] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const del = useMutation({
    mutationFn: () => api.quiz.deleteFlashcards(sel),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['flashcards'] });
      toast(`${sel.length}장을 삭제했어요`);
      setSel([]);
      setSelect(false);
    },
  });
  return (
    <Screen
      footer={
        select &&
        sel.length > 0 && (
          <Btn
            kind="danger"
            loading={del.isPending}
            onPress={() => del.mutate()}
          >{`${sel.length}장 삭제`}</Btn>
        )
      }
    >
      <View className="mt-3 flex-row items-center justify-between">
        <Pressable
          onPress={() => router.back()}
          className="flex-row items-center gap-2 rounded-full border border-line px-3 py-1.5"
        >
          <ArrowLeft size={ICON.sm} color={C.ink} />
          <Text className="text-footnote text-ink">뒤로 가기</Text>
        </Pressable>
        <Pressable
          onPress={() => setSelect((x) => !x)}
          className={cx('rounded-full px-3 py-1', select ? 'bg-ink' : 'border border-line')}
        >
          <Text className={cx('text-caption', select ? 'text-white' : 'text-ink')}>
            {select ? '취소' : '선택'}
          </Text>
        </Pressable>
      </View>
      {cards.isError && !cards.data && <ErrorAlert retry={() => cards.refetch()} />}
      <View className="mt-4 flex-row flex-wrap justify-between gap-y-3">
        {cards.data?.map((c, i) => (
          <Pressable
            key={c._id}
            onPress={() =>
              select
                ? setSel((p) => (p.includes(c._id) ? p.filter((x) => x !== c._id) : [...p, c._id]))
                : router.replace({ pathname: '/play/flash', params: { i: String(i) } })
            }
            className={cx(
              'h-36 w-[48.5%] items-center justify-center rounded-2xl border bg-mint p-3',
              sel.includes(c._id) ? 'border-2 border-brand' : 'border-line',
            )}
          >
            <Text className="text-center text-footnote font-semibold text-ink">{c.front}</Text>
          </Pressable>
        ))}
      </View>
    </Screen>
  );
}

export function QuizBoxScreen() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  const remove = useMutation({
    mutationFn: (ids: string[]) => api.quiz.deleteFromBox(ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['quiz-box'] });
      setSelected([]);
      toast('선택한 퀴즈를 삭제했어요');
    },
    onError: () => toast('보관함에서 삭제하지 못했어요. 다시 시도해 주세요'),
  });
  const box = useQuery({ queryKey: ['quiz-box'], queryFn: api.quiz.box });
  const [shown, setShown] = useState<string[]>([]);
  const [select, setSelect] = useState(false);
  // 보관함을 불러오면 첫 퀴즈의 정답을 펼친다 (렌더 중 상태 조정)
  const [loaded, setLoaded] = useState<typeof box.data>();
  if (box.data && box.data !== loaded) {
    setLoaded(box.data);
    if (box.data[0]) setShown([box.data[0]._id]);
  }
  if (box.isError && !box.data)
    return (
      <Screen>
        <Text>보관함을 불러오지 못했어요</Text>
        <Btn loading={box.isFetching} onPress={() => void box.refetch()}>
          다시 시도
        </Btn>
        <Btn kind="outline" onPress={() => router.back()}>
          뒤로
        </Btn>
      </Screen>
    );
  if (!box.data) return <Loading />;
  return (
    <Screen
      footer={
        select ? (
          <Btn
            disabled={!selected.length}
            loading={remove.isPending}
            onPress={() => remove.mutate(selected)}
          >
            선택 삭제
          </Btn>
        ) : (
          <Btn onPress={() => router.back()}>확인</Btn>
        )
      }
    >
      <View className="flex-row items-center justify-between pt-5">
        <Text className="text-body font-bold text-ink">퀴즈 보관함</Text>
        <Pressable
          onPress={() => {
            setSelect((x) => !x);
            setSelected([]);
          }}
          className={cx('rounded-full px-3 py-1', select ? 'bg-ink' : 'border border-line')}
        >
          <Text className={cx('text-caption', select ? 'text-white' : 'text-ink')}>
            {select ? '완료' : '선택'}
          </Text>
        </Pressable>
      </View>
      {!box.data.length && <Text>보관한 퀴즈가 없어요</Text>}
      <View className="mt-3 gap-2">
        {box.data?.map((q, n) => (
          <View key={q._id} className="rounded-2xl bg-cream p-3">
            <View className="flex-row items-start gap-2">
              <View className="h-5 w-5 items-center justify-center rounded-full bg-brand">
                <Text className="text-caption2 text-white">{n + 1}</Text>
              </View>
              <Text className="flex-1 text-footnote text-ink">Q. {q.prompt}</Text>
            </View>
            {shown.includes(q._id) && (
              <Animated.View entering={FadeIn} className="mt-2 rounded-lg bg-mint px-3 py-2">
                <Text className="text-caption text-brand">A. {q.answer}</Text>
              </Animated.View>
            )}
            <View className="mt-2 flex-row gap-1.5 pl-7">
              {!shown.includes(q._id) && (
                <Pressable
                  onPress={() => setShown((p) => [...p, q._id])}
                  className="rounded-full bg-mint px-2.5 py-1"
                >
                  <Text className="text-caption2 text-brand">정답 보기</Text>
                </Pressable>
              )}
              <Pressable
                onPress={() => router.push({ pathname: '/play/explain', params: { qid: q._id } })}
                className="rounded-full bg-mint px-2.5 py-1"
              >
                <Text className="text-caption2 text-brand">AI 설명 보기</Text>
              </Pressable>
              {select && (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityLabel={`보관함 선택 ${q._id}`}
                  accessibilityState={{ checked: selected.includes(q._id) }}
                  disabled={remove.isPending}
                  onPress={() =>
                    setSelected((ids) =>
                      ids.includes(q._id) ? ids.filter((id) => id !== q._id) : [...ids, q._id],
                    )
                  }
                >
                  <Badge tone="gray">{selected.includes(q._id) ? '선택됨' : '선택'}</Badge>
                </Pressable>
              )}
            </View>
          </View>
        ))}
      </View>
    </Screen>
  );
}
