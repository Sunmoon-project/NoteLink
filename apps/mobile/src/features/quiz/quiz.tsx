import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus, TextInput, View } from 'react-native';
import { Pressable } from '@/components/press';
import { Text } from '@/components/text';
import Animated, {
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { router, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Speech from 'expo-speech';
import { setAudioModeAsync } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import {
  Archive,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Brain,
  CircleCheck,
  FileText,
  GraduationCap,
  Layers,
  PartyPopper,
  PenLine,
  Plus,
  Sparkles,
  Volume2,
  X,
} from 'lucide-react-native';
import {
  ERROR_CODES,
  type AiJob,
  type Flashcard,
  type Material,
  type QuizSet,
} from '@notelink/shared';
import { api, ApiError } from '@/lib/api';
import { useFeatureNavigation } from '@/lib/feature-navigation';
import { useAiJobSubscription, useSocket, useTabRefresh } from '@/hooks';
import { useQuizProgress } from '@/stores/quiz-progress';
import { queryClient } from '@/lib/query';
import { useBgJobs } from '@/stores/bg-jobs';
import { useAuth } from '@/stores/auth';
import { useNet } from '@/stores/net';
import { toast } from '@/stores/toast';
import {
  Alert,
  Badge,
  Btn,
  Canvas,
  Card,
  Chip,
  Empty,
  Group,
  Header,
  LIST_LAYOUT,
  Label,
  Loading,
  Progress,
  RollUp,
  Row,
  Screen,
  Search,
  Title,
  cx,
  BACKDROP_IN,
  BACKDROP_OUT,
  FADE_IN,
  popInFrom,
} from '@/components/ui';
import { NetBanner } from '@/components/NetBanner';
import { C, ICON, MOTION } from '@/theme';
import { AvatarCheer } from '@/features/tutor/cheer';
import { ChoiceRow, Passage, splitPrompt } from './choice';
import { readFolderMaterials } from '@/features/content/notes';
import { ALL_FOLDERS, boxFolder, FolderGrid, FolderPickScreen } from './folder-pick';
import { canPickFrom, SimilarPickScreen, SimilarStatus, useSimilarMaking } from './similar-pick';
import { recordWrong } from './wrong-review';
import { TodayReviewCard, useTodayReview } from './today-review';
import { NextStepCard, reviewDayWord, type NextStep } from './next-step';
import { useTourTarget } from '@/features/tutor/tour';
import { seoul, today as seoulToday } from '@/lib/dates';
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

/** AI 튜터 — 이모지 대신 학사모 아이콘 (이모지 아이콘 금지, DESIGN.md) */
const Tutor = ({ size = 76 }: { size?: number }) => (
  <View
    accessibilityLabel="AI 튜터"
    className="items-center justify-center self-center rounded-full bg-mint"
    style={{ width: size, height: size }}
  >
    <GraduationCap size={Math.round(size * 0.46)} color={C.brand} strokeWidth={1.8} />
  </View>
);

/** 플래시 카드가 없을 때 안내(#601): 카드는 퀴즈를 만들면 그 노트로 자동으로 생긴다(#557) */
const NO_CARDS = '이 노트로 퀴즈를 만들면 플래시 카드가 생겨요.';

/** 만드는 중인 퀴즈 세트가 있을 때 퀴즈 탭이 세트 목록을 다시 읽는 간격(#593) */
const PENDING_POLL_MS = 4000;

/**
 * 앱이 앞에 나와 있는지. 앱이 뒤로 가도 화면 포커스는 그대로라 다시 읽기를 멈추려고 따로 본다(#593).
 * 켜자마자는 상태를 아직 모를 수 있어(unknown) 뒤에 있다고 확실할 때만 멈춘다
 */
const isBackground = (s: AppStateStatus | null) => s === 'background' || s === 'inactive';
function useAppActive() {
  const [active, setActive] = useState(() => !isBackground(AppState.currentState));
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(!isBackground(s)));
    return () => sub.remove();
  }, []);
  return active;
}

export function QuizHomeScreen() {
  // 처음 안내의 '퀴즈 만들기'가 짚는 자리
  const makeTarget = useTourTarget('quiz-make');
  // 오늘의 복습은 위 카드가 진행률을 보여 주므로 「퀴즈 생성 중」 · 맨 위 카드에는 넣지 않는다
  const todayId = useTodayReview().data?._id;
  const focused = useIsFocused();
  const appActive = useAppActive();
  // 오늘의 복습 세트는 오늘의 복습 카드가 따로 다시 읽고 보여 준다. 그 조회가 오기 전에도 빼려고 오늘(서울) reviewDay도
  // 함께 본다. 지난 날 복습 세트는 그 카드에 나오지 않으므로 여기서 안내한다
  const pending = (s: QuizSet) =>
    s.status === 'generating' && s._id !== todayId && s.reviewDay !== seoulToday();
  // 만드는 중 세트(맞춤 퀴즈 · 유사 퀴즈 등)가 있으면 이 탭이 보이고 앱이 앞에 있는 동안에만 다시 읽어, 다 만들어지면
  // 「AI 서버를 기다리고 있어요」 안내가 바로 사라지게 한다(#593). 퀴즈를 끝낸 뒤 저절로 만드는 「다시 보기」 세트는
  // 서버 설정이 켜졌을 때만 생긴다(#625, 기본 꺼짐)
  const sets = useQuery({
    queryKey: ['quiz-sets'],
    queryFn: api.quiz.sets,
    refetchInterval: (q) =>
      focused && appActive && q.state.data?.some(pending) ? PENDING_POLL_MS : false,
  });
  const refresh = useTabRefresh(sets);
  const progress = useQuizProgress((s) => s.progress);
  // 바로가기(유사 퀴즈 등)는 다 푼 세트도 쓰므로 가장 최근 ready 세트, 맨 위 카드는 아직 끝까지 풀지 않은 세트(#561).
  // 맨 위 카드는 오늘의 복습 세트(reviewDay, 지난 날 사본 포함)도 고르지 않는다. todayId는 reviewDay를 보내지 않는
  // 옛 서버에서도 오늘 세트를 빼려고 함께 본다. 세트 종류(맞춤 · 유사 · 「다시 보기」)와 상관없이 한 번 들어갔으면
  // (started) 끝까지 풀지 않았어도 고르지 않는다(#593). 단 풀던 진행(progress)이 있으면 그 세트를 「이어서 풀기」로
  // 남긴다(#593 결정: 이어 풀 길을 지킴). 진행은 메모리라 앱을 다시 켜면 사라지고, 그때는 started로 빠진다
  const recent = sets.data?.find((s) => s.status === 'ready');
  const latest = progress
    ? (sets.data?.find((s) => s._id === progress.setId) ?? {
        _id: progress.setId,
        title: '풀던 퀴즈',
        questionCount: 0,
      })
    : sets.data?.find(
        (s) =>
          s.status === 'ready' && !s.completed && !s.reviewDay && s._id !== todayId && !s.started,
      );
  const shortcutSetId = progress ? latest?._id : recent?._id;
  // 유사 퀴즈는 끝까지 푼 퀴즈의 문제로 만든다: 끝낸 세트(completed)가 있을 때만 바로가기를 보인다. 세트는 넘기지 않고
  // 노트 → 문제를 고르게 한다(#605)
  const canSimilar = !!sets.data?.some(canPickFrom);
  const waiting = sets.data?.filter(pending) ?? [];
  return (
    <Canvas>
      <Screen refresh={refresh}>
        <NetBanner />
        <Title>학습 퀴즈</Title>
        <TodayReviewCard />
        {waiting.length > 0 && (
          <View className="mt-4">
            <AiPending
              what={`퀴즈 ${waiting.length}개 생성`}
              hint={waiting.map((w) => w.title).join(' · ')}
            />
          </View>
        )}
        {shortcutSetId ? (
          <>
            {latest && (
              <Card
                tone="mint"
                onPress={() =>
                  router.push({ pathname: '/play/solve', params: { setId: latest._id } })
                }
                className="mt-1 p-6"
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
            )}
            {/* 바로가기는 같은 모양 카드 격자 대신 한 그룹의 목록 행 (디자인 점검: 찍어 낸 카드 격자) */}
            <Label>바로가기</Label>
            <Group>
              {(
                [
                  [PenLine, '퀴즈 만들기', '노트를 골라 새 퀴즈를 만들어요', '/(tabs)/quiz/notes'],
                  [Layers, '플래시 카드', '외울 내용을 넘겨 보며 복습해요', '/play/flash'],
                  [Archive, '퀴즈 보관함', '저장한 문제를 다시 풀어요', '/play/box'],
                  [Sparkles, '유사 퀴즈', '틀린 문제와 비슷한 문제를 풀어요', '/play/similar'],
                ] as const
              )
                // 유사 퀴즈는 끝낸 세트가 있어야 만들 수 있다: 없으면 고를 문제가 없으니 바로가기를 숨긴다
                .filter(([, , , href]) => href !== '/play/similar' || canSimilar)
                .map(([Ic, l, sub, href]) => (
                  <View
                    key={l}
                    ref={l === '퀴즈 만들기' ? makeTarget : undefined}
                    collapsable={false}
                  >
                    <Row
                      icon={Ic}
                      sub={sub}
                      chevron
                      onPress={() =>
                        router.push({
                          pathname: href as never,
                          params: href === '/play/similar' ? {} : { setId: shortcutSetId },
                        })
                      }
                    >
                      {l}
                    </Row>
                  </View>
                ))}
            </Group>
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
              {/* 여백은 바깥에: 처음 안내가 재는 영역(makeTarget)이 버튼과 꼭 맞게 */}
              <View ref={makeTarget} collapsable={false} className="mt-5">
                <Btn small className="w-56" onPress={() => router.push('/(tabs)/quiz/notes')}>
                  노트 업로드하고 퀴즈 만들기
                </Btn>
              </View>
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

/** 퀴즈를 만들 수 있는 자료: 정리(요약)가 끝났거나 정리할 것이 없는 자료 */
const quizReady = (m: Material) => !m.processing || m.processing.status === 'done';

/**
 * 퀴즈는 노트(자료) 하나로 만든다 (FR-38-02). 노트 탭처럼 1단계에서 학습 폴더를 고르고, 같은 화면을 그 폴더(`folderId`)로
 * 한 번 더 열어 2단계에서 그 폴더의 정리 끝난 자료를 고른다(#575). 뒤로 가면 1단계로 돌아온다.
 * 자료 목록은 노트 탭 폴더 화면과 같은 키 · 읽기(readFolderMaterials)로 그 폴더 한 번만 읽는다
 */
export function QuizNotesScreen() {
  const { folderId } = useLocalSearchParams<{ folderId?: string }>();
  const openFeature = useFeatureNavigation();
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.content.folders });
  const mats = useQuery({
    queryKey: ['materials', folderId],
    queryFn: ({ signal }) => readFolderMaterials(folderId!, signal),
    enabled: !!folderId,
  });
  const folder = folders.data?.find((f) => f._id === folderId);
  const [picked, setPicked] = useState<string | null>(null);
  const offline = useNet((s) => s.state === 'offline');
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState(false);
  const notes = (mats.data ?? []).filter(quizReady);
  const folderList = (folders.data ?? []).filter((f) => f.title.includes(q));
  // 노트 탭 폴더 화면(FolderScreen)처럼, 폴더 목록이 센 자료가 0개인데 자료 목록이 404면 실패가 아니라 빈 폴더다
  const mats404 = !mats.data && (mats.error as { status?: number } | null)?.status === 404;
  const emptyFolder = mats404 && folder?.materialCount === 0;
  // 1단계는 폴더 목록, 2단계는 폴더 목록(제목 · 과목) + 그 폴더 자료 목록을 기준으로 오류 · 빈 상태를 보인다.
  // 404는 폴더 목록이 와야 빈 폴더인지 알 수 있어, 폴더 목록을 읽는 동안에는 오류로 보이지 않는다
  const failed = folderId
    ? (folders.isError && !folders.data) ||
      (mats.isError && !mats.data && !emptyFolder && !(mats404 && folders.isPending))
    : folders.isError && !folders.data;
  // 오류를 보이는 동안에는 고를 수 있는 자료 카드를 같이 보이지 않는다
  const list = failed ? [] : notes.filter((f) => f.title.includes(q));
  const chosen = list.find((f) => f._id === picked);
  const retry = () => {
    if (folders.isError) void folders.refetch();
    if (folderId && mats.isError) void mats.refetch();
  };
  const empty =
    !failed &&
    (folderId
      ? (mats.isSuccess && notes.length === 0) || emptyFolder
      : folders.isSuccess && folders.data.length === 0);
  const folderParams = folderId ? { folderId } : {};
  const make = () =>
    chosen
      ? router.push({
          pathname: '/play/gen',
          params: { materialId: chosen._id, title: chosen.title },
        })
      : toast('퀴즈를 만들 노트를 먼저 골라 주세요');
  return (
    <Canvas>
      <Screen footer={chosen ? <Btn onPress={make}>이 노트로 퀴즈 만들기</Btn> : undefined}>
        <NetBanner />
        <Header
          title={folderId ? (folder?.title ?? '') : '어떤 노트로 퀴즈를 만들까요?'}
          large={false}
        />
        <Search value={q} onChangeText={setQ} placeholder="노트 검색" />
        {failed && <ErrorAlert retry={retry} />}
        {empty && (
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
        {!folderId && (
          // 노트 탭(NoteListScreen)과 같은 학습 폴더 카드(보관함 · 플래시 카드 1단계와 같은 격자, #601)
          <FolderGrid
            folders={folderList}
            onPick={(id) =>
              router.push({ pathname: '/(tabs)/quiz/notes', params: { folderId: id } })
            }
          />
        )}
        <View className="mt-3 flex-row flex-wrap justify-between gap-y-3">
          {list.map((f) => (
            <Animated.View
              key={f._id}
              // 2열 폭은 목록 기준으로 이 래퍼가 갖고, 카드는 래퍼를 채운다
              className="w-[48.5%]"
              layout={LIST_LAYOUT}
              entering={FadeIn.duration(MOTION.enter)}
              exiting={FadeOut.duration(MOTION.exit)}
            >
              <Card
                tone="mint"
                onPress={() =>
                  offline
                    ? toast('연결되면 퀴즈를 만들 수 있어요 · 노트는 그대로 볼 수 있어요')
                    : setPicked(f._id)
                }
                className={cx('w-full p-2.5', picked === f._id && 'border-2 border-blue')}
              >
                <View className="h-16 items-center justify-center rounded-xl bg-white">
                  <FileText size={ICON.lg} color={C.brand} />
                </View>
                <Text className="mt-2 px-1 text-footnote font-semibold text-ink">{f.title}</Text>
                <Text className="px-1 text-caption2 text-sub">
                  {folder?.subjectName && `${folder.subjectName} · `}
                  {seoul(f.createdAt).getMonth() + 1}/{seoul(f.createdAt).getDate()}
                </Text>
              </Card>
            </Animated.View>
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
        <Animated.View
          entering={BACKDROP_IN}
          exiting={BACKDROP_OUT}
          className="absolute inset-0 z-20"
        >
          <Pressable className="absolute inset-0 bg-black/45" onPress={() => setMenu(false)} />
          <View
            className={cx('absolute right-5 items-end gap-3', chosen ? 'bottom-44' : 'bottom-24')}
          >
            {(
              [
                // 2단계(폴더를 고른 뒤)면 그 폴더의 카드 · 보관 문제를 바로, 1단계면 폴더 고르기부터 연다(#601)
                [
                  '플래시 카드',
                  Layers,
                  () => router.push({ pathname: '/play/flash', params: folderParams }),
                ],
                [
                  '퀴즈 보관함',
                  Archive,
                  () => router.push({ pathname: '/play/box', params: folderParams }),
                ],
                [
                  '새 노트 올리고 만들기',
                  FileText,
                  () => openFeature('/(tabs)/note', 'navigate', '/capture/picked'),
                ],
                ['퀴즈 만들기', PenLine, make],
              ] as const
            ).map(([l, Ic, fn], i, all) => (
              <Animated.View key={l} entering={popInFrom(all.length - 1 - i)}>
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
        </Animated.View>
      )}
      <Pressable
        accessibilityLabel={menu ? '닫기' : '메뉴'}
        onPress={() => setMenu((m) => !m)}
        className={cx(
          'absolute right-5 z-30 h-14 w-14 items-center justify-center rounded-full shadow-lg',
          chosen ? 'bottom-24' : 'bottom-5',
          menu ? 'bg-brand' : 'bg-white',
        )}
      >
        {menu ? <X size={ICON.lg} color="#fff" /> : <Plus size={ICON.lg} color={C.ink} />}
      </Pressable>
    </Canvas>
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
  // 진행 상황 구독(소켓이 다시 연결되면 다시 구독)
  useAiJobSubscription(job?._id);
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
    <Canvas>
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
        {job && (
          <View className="mt-10 px-4">
            <Btn
              kind="outline"
              onPress={() => {
                // 기다리지 않고 퀴즈 탭으로: 서버는 계속 만들고, 끝나면 전역에서 알려 준다(stores/bg-jobs)
                canceled.current = true;
                useBgJobs.getState().add({ jobId: job._id, kind: 'quiz', title: title || '노트' });
                qc.invalidateQueries({ queryKey: ['quiz-sets'] });
                router.dismissTo('/(tabs)/quiz');
                toast('다 만들면 알려 드릴게요');
              }}
            >
              퀴즈 탭에서 기다리기
            </Btn>
            <Text className="mt-2 text-center text-caption2 text-sub">
              다른 공부를 해도 문제는 계속 만들어지고, 끝나면 알려 드려요
            </Text>
          </View>
        )}
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
    </Canvas>
  );
}

export function QuizReadyScreen() {
  const { setId, title } = useLocalSearchParams<{ setId: string; title?: string }>();
  // 문제 수는 서버가 만든 실제 값을 보여 준다. 못 읽으면 숫자 없이 안내한다
  const set = useQuery({ queryKey: ['quiz-set', setId], queryFn: () => api.quiz.set(setId) });
  const count = set.data?.questionCount;
  return (
    <Canvas>
      <Screen
        footer={
          <>
            <Btn onPress={() => router.replace({ pathname: '/play/solve', params: { setId } })}>
              퀴즈 시작하기
            </Btn>
            {/* 시작 버튼과 붙어 보이지 않게 띄우고, 화면 아래 끝에서 조금 올린다 */}
            <Pressable
              onPress={() => router.dismissTo('/(tabs)/quiz')}
              className="mt-4 mb-6 self-center rounded-full bg-white px-4 py-2"
            >
              <Text className="text-footnote text-sub">나중에 풀기</Text>
            </Pressable>
          </>
        }
      >
        <View className="items-center pt-40">
          <Animated.View
            entering={FADE_IN}
            className="h-20 w-20 items-center justify-center rounded-full bg-mint"
          >
            <CircleCheck size={ICON.xl} color={C.brand} />
          </Animated.View>
          <Text className="mt-5 text-headline font-bold text-ink">
            {count ? `총 ${count}문제가 생성됐어요!` : '문제가 생성됐어요!'}
          </Text>
          {!!title && (
            <Text className="mt-2 px-8 text-center text-footnote leading-5 text-sub">
              {title} 노트를 기반으로 만들었어요
            </Text>
          )}
        </View>
      </Screen>
    </Canvas>
  );
}

/** 채점 결과를 보여 주는 시간. 그 뒤 저절로 다음 문제로 */
export const AUTO_NEXT_MS = 1200;

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
  const [quit, setQuit] = useState(false);
  // 지금 유효한 읽기 요청 번호. 멈추기 · 화면 떠나기 · 다음 문제로 넘어가기에서 올려 준비 중인 읽기를 무효로 한다
  const speechToken = useRef(0);
  useEffect(
    () => () => {
      speechToken.current++;
      void Speech.stop();
    },
    [],
  );
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
      questionIds: string[];
      /** 풀던 세트의 reviewDay. 오늘의 복습 세트(지난 날 사본 포함)만 날짜가 있다(#595) */
      reviewDay?: string | null;
    }) => api.quiz.finish(request.attemptId),
    // 완료는 포인트를 적립하므로 응답 유실 시 자동으로 재전송하지 않는다.
    retry: false,
    onSuccess: (r, request) => {
      // 다 푼 퀴즈는 보관함에 자동으로 담는다(이미 담긴 문제는 서버가 건너뜀). 오늘의 복습은 이미 가진 문제의
      // 사본이라 담지 않고, 끝냈다고 다시 읽어 카드가 「마쳤어요」로 바뀌게 한다
      // 그사이 다른 계정으로 바뀌었으면 담지 않는다(새 계정 보관함에 앞 계정 문제가 들어가지 않게)
      if (useAuth.getState().userId !== request.owner) return;
      // 끝낸 세트는 목록에서 completed가 되므로, 퀴즈 탭 맨 위 카드가 돌아오자마자 다음 세트로 바뀌게 다시 읽는다(#561)
      void queryClient.invalidateQueries({ queryKey: ['quiz-sets'] });
      // 오늘의 복습인지는 세트의 reviewDay로 본다. 캐시는 비어 있을 수 있고(앱을 다시 켜고 이어 풀기),
      // 지난 날 사본이면 오늘 세트와 id가 달라서다(#595). 캐시 id 비교는 reviewDay를 보내지 않는 옛 서버용으로 남긴다
      const today = queryClient.getQueryData<{ _id: string } | null>(['today-review']);
      if (request.reviewDay || today?._id === request.setId)
        void queryClient.invalidateQueries({ queryKey: ['today-review'] });
      else
        api.quiz
          .saveToBox(request.questionIds)
          .then(() => queryClient.invalidateQueries({ queryKey: ['quiz-box'] }))
          .catch(() => toast('푼 문제를 보관함에 담지 못했어요. 연결을 확인해 주세요'));
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
          // 풀이가 생기면 목록이 이 세트를 started로 알려 준다: 퀴즈 탭 맨 위 카드가 들어간 세트를
          // 돌아오자마자 빼게 다시 읽는다(#593)
          void queryClient.invalidateQueries({ queryKey: ['quiz-sets'] });
          if (active && ownsProgress()) setAttemptId(a._id);
        })
        .catch(() => {
          if (active && ownsProgress()) setStartError(true);
        });
    return () => {
      active = false;
    };
  }, [set.data?._id, startRound]); // eslint-disable-line react-hooks/exhaustive-deps
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
    const answered = useQuizProgress.getState().progress?.results ?? [];
    useQuizProgress.getState().reset();
    router.replace({
      pathname: '/play/review',
      params: {
        setId: completedSetId,
        points: String(completed.pointsEarned),
        // 문제마다 맞음(1) · 틀림(0): 결과 화면이 번호를 초록 · 빨강으로 칠한다
        results: answered.map(Number).join(''),
        // 서버가 이번에 복습 일정에 넣은 문제 수 · 날짜(FR-37). 넣지 않았거나 옛 서버면 넘기지 않는다
        ...(completed.scheduled && completed.nextReviewDay
          ? { scheduled: String(completed.scheduled), nextReviewDay: completed.nextReviewDay }
          : {}),
        ...(from === 'room' ? { from: 'room' } : {}),
      },
    });
  }, [completed, attemptId, completedSetId, ownsProgress, from]);
  // 채점이 끝나면 잠깐 결과를 보여 주고 다음 문제로(마지막 문제면 결과로) 넘어간다. 다시 풀기는 두지 않는다
  const autoNext = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(autoNext.current), []);
  if (set.isError && !set.data)
    return (
      <Canvas>
        <Screen>
          <Text>퀴즈를 불러오지 못했어요</Text>
          <Btn onPress={() => set.refetch()}>다시 시도</Btn>
        </Screen>
      </Canvas>
    );
  if (!set.data) return <Loading />;
  const qs = set.data.questions;
  const q = qs[i];
  // 문제가 없거나 저장된 위치가 어긋나면 로딩에 갇히지 않게 나갈 길을 준다
  if (!q)
    return (
      <Canvas>
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
      </Canvas>
    );
  const speak = async () => {
    // 읽기 요청마다 번호를 매겨, 준비(오디오 설정)를 기다리는 사이 멈추거나 화면을 떠나면 읽지 않는다(Codex #507 리뷰)
    const token = ++speechToken.current;
    if (speaking) {
      void Speech.stop();
      return setSpeaking(false);
    }
    setSpeaking(true);
    // 아이폰 무음 스위치가 켜져 있어도 들리게 한다(기본 오디오 설정은 무음 모드에서 소리를 내지 않아
    // 「음성으로 듣기」를 눌러도 아무 소리가 나지 않았다)
    await setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
    // 취소된 요청이 여기서 멈추기를 부르면 그사이 시작한 새 읽기가 끊긴다. 멈추기 전에도 확인한다(Codex #507 재리뷰)
    if (token !== speechToken.current) return;
    // 앞에서 멈추지 못한 읽기가 남아 있으면 새 읽기가 뒤로 밀려 들리지 않는다
    await Speech.stop()?.catch?.(() => {});
    if (token !== speechToken.current) return;
    Speech.speak(`${q.prompt}. ${(q.choices ?? []).map((c, n) => `${n + 1}번, ${c}`).join('. ')}`, {
      language: 'ko-KR',
      onDone: () => setSpeaking(false),
      onStopped: () => setSpeaking(false),
      onError: () => {
        setSpeaking(false);
        toast('음성을 재생하지 못했어요. 기기 소리 설정을 확인해 주세요');
      },
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
      // 틀린 문제는 오답 노트에 모아 다음 날 처음 열 때 다시 풀게 한다
      if (!r.correct) recordWrong(screenOwner, q, set.data?.title);
      setRight(r.correct);
      setResults((x) => [...x, r.correct]);
      clearTimeout(autoNext.current);
      autoNext.current = setTimeout(next, AUTO_NEXT_MS);
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
    clearTimeout(autoNext.current);
    if (finishing.current || completing) return;
    // 읽던 · 읽으려고 준비 중인 앞 문제는 무효로 하고 멈춘다(다음 문제에서 앞 문제를 읽지 않게)
    speechToken.current++;
    if (speaking) {
      setSpeaking(false);
      void Speech.stop();
    }
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
        questionIds: qs.map((x) => x._id),
        reviewDay: set.data.reviewDay,
      });
      return;
    }
    setI((x) => x + 1);
    setAnswerText('');
    setPick(null);
    setRight(null);
  };
  return (
    <Canvas>
      <Screen
        footer={
          pick === null ? (
            <Btn
              kind="cream"
              icon={<Volume2 size={ICON.sm} color={C.ink} />}
              onPress={() => void speak()}
            >
              {speaking ? '읽어주는 중… (탭해서 멈춤)' : '음성으로 듣기'}
            </Btn>
          ) : right !== null ? (
            // 맞든 틀리든 잠깐 결과를 보여 준 뒤 저절로 넘어간다(기다리지 않으려면 눌러서 바로)
            <Btn loading={finish.isPending || completing} onPress={next}>
              다음 문제 풀기
            </Btn>
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
        {/* 나가는 길이 가장자리 밀기뿐이었다(develop 점검 #8). 스터디룸에서 왔으면 그 버튼이 나가기를 겸한다 */}
        {from === 'room' ? (
          <Pressable onPress={() => setQuit(true)} className="mt-3 flex-row items-center gap-2">
            <ArrowLeft size={ICON.sm} color={C.ink} />
            <Text className="text-footnote text-ink">스터디룸으로</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="풀이 닫기"
            hitSlop={10}
            onPress={() => setQuit(true)}
            className="mt-1 -ml-2 h-control w-control items-center justify-center"
          >
            <X size={ICON.lg} color={C.ink} />
          </Pressable>
        )}
        <Progress value={((i + (right === null ? 0 : 1)) / qs.length) * 100} className="mt-5" />
        <Text className="pt-4 text-center text-caption text-sub">
          복습 퀴즈 {i + 1} / {qs.length}
          {q.difficulty ? ` · 난이도 ${q.difficulty}` : ''}
        </Text>
        <View className="mt-4">
          <Tutor size={pick === null ? 76 : 70} />
        </View>
        {pick === null || right === null ? (
          <Animated.View entering={FADE_IN}>
            <Text className="mt-7 text-callout leading-6 font-bold text-ink">{q.prompt}</Text>
            <View className="mt-6 gap-3.5">
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
                <ChoiceRow key={c} n={n} on={pick === c} onPress={() => choose(c)}>
                  {c}
                </ChoiceRow>
              ))}
            </View>
          </Animated.View>
        ) : (
          <Animated.View entering={FADE_IN}>
            {/* 정답은 채워지며 체크, 오답은 좌우로 살짝 흔들림 (240ms · 4px × 2) */}
            <Shake on={!right}>
              <View
                className={cx(
                  'mt-8 flex-row items-center justify-center gap-1.5 rounded-xl py-2.5',
                  right ? 'bg-correct-soft' : 'bg-danger/10',
                )}
              >
                {right ? (
                  <CircleCheck size={ICON.sm} color={C.correct} />
                ) : (
                  <X size={ICON.sm} color={C.danger} />
                )}
                <Text
                  className={cx(
                    'text-footnote font-semibold',
                    right ? 'text-correct' : 'text-danger',
                  )}
                >
                  {right ? '정답이에요' : '오답이에요'}
                </Text>
              </View>
            </Shake>
            {!right && (
              <Text className="mt-3 text-center text-caption text-sub">
                내가 고른 답: {pick} · 정답: {q.answer}
              </Text>
            )}
            {/* 아바타 선생님: 맞히면 칭찬, 틀리면 격려 */}
            <AvatarCheer right={!!right} index={i} />
            <View className="mt-6 flex-row items-center justify-center gap-2">
              <Text className="text-footnote text-sub">결과</Text>
              {qs.map((_, n) => (
                <View
                  key={n}
                  className={cx(
                    'h-3 w-3 rounded-full',
                    n < results.length ? (results[n] ? 'bg-correct' : 'bg-danger') : 'bg-fill',
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
      {/* 채점한 답은 서버에 바로 저장되고, 풀던 위치는 앱이 켜져 있는 동안 남아 퀴즈 탭 「이어서 풀기」로 돌아온다 */}
      <Alert
        open={quit}
        tone="brand"
        icon="?"
        title="그만 풀까요?"
        body="채점한 문제까지 저장돼요. 앱을 끄기 전에는 퀴즈 탭의 「이어서 풀기」로 이어 풀 수 있어요."
        primary="계속 풀기"
        onPrimary={() => setQuit(false)}
        secondary="그만 풀기"
        onSecondary={() => {
          setQuit(false);
          if (router.canGoBack()) router.back();
          else router.replace('/(tabs)/quiz');
        }}
        onClose={() => setQuit(false)}
      />
    </Canvas>
  );
}

export function QuizReviewScreen() {
  const { setId, points, from, results, scheduled, nextReviewDay } = useLocalSearchParams<{
    setId?: string;
    points?: string;
    from?: string;
    results?: string;
    scheduled?: string;
    nextReviewDay?: string;
  }>();
  const set = useQuery({
    queryKey: ['quiz-set', setId ?? 'latest'],
    queryFn: () => api.quiz.set(setId ?? ''),
  });
  const qc = useQueryClient();
  const [reward, setReward] = useState(Number(points) > 0);
  useEffect(() => {
    if (points) qc.invalidateQueries({ queryKey: ['me'] });
  }, [points]); // eslint-disable-line react-hooks/exhaustive-deps
  const qs = set.data?.questions ?? [];
  if (set.isError && !set.data)
    return (
      <Canvas>
        <Screen>
          <Text>완료한 퀴즈를 불러오지 못했어요</Text>
          <Btn loading={set.isFetching} onPress={() => void set.refetch()}>
            다시 시도
          </Btn>
          <Btn kind="outline" onPress={() => router.back()}>
            뒤로
          </Btn>
        </Screen>
      </Canvas>
    );
  if (!set.data) return <Loading />;
  // 오늘의 복습(지난 날 사본 포함)은 보관함에 담지 않으므로 그 안내를 뺀다. 완료 처리(QuizSolveScreen)와 같게
  // reviewDay로 보고, reviewDay를 보내지 않는 옛 서버는 오늘의 복습 캐시 id로 본다(#595)
  const reviewCopy =
    !!set.data.reviewDay ||
    queryClient.getQueryData<{ _id: string } | null>(['today-review'])?._id === set.data._id;
  return (
    <Canvas>
      <Screen
        footer={
          <>
            <Btn
              onPress={() => (from === 'room' ? router.back() : router.dismissTo('/(tabs)/quiz'))}
            >
              확인
            </Btn>
          </>
        }
      >
        <View className="flex-row items-center justify-between pt-6">
          <Text className="text-title3 font-bold text-ink">퀴즈 결과</Text>
          {!!results && (
            <Text className="text-footnote font-semibold text-sub">
              {[...results].filter((r) => r === '1').length} / {qs.length} 맞힘
            </Text>
          )}
        </View>
        <View className="mt-5 rounded-2xl bg-mint px-4 py-3.5">
          <View className="flex-row items-center gap-2">
            <PartyPopper size={ICON.xs} color={C.brand} />
            <Text className="text-center text-footnote font-semibold text-ink">
              미션 완료! {qs.length}문제를 모두 풀었어요
            </Text>
          </View>
          <Text className="mt-1 text-caption text-sub">
            문제를 누르면 AI 해설을 볼 수 있어요
            {reviewCopy ? '' : ' · 푼 퀴즈는 보관함에 담았어요'}
          </Text>
        </View>
        <View className="mt-3">
          <QuizNextStep
            setId={set.data._id}
            // 노트 폴더가 있는 세트는 고르기 화면(#610)으로. 오늘의 복습(노트를 섞음) · 폴더가 없는 옛 세트는 그 세트로 만든다
            pickFolder={
              set.data.folderId && set.data.materialId && !reviewCopy
                ? set.data.folderId
                : undefined
            }
            results={results}
            reviewDay={Number(scheduled) > 0 ? nextReviewDay : undefined}
            room={from === 'room'}
          />
        </View>
        <View className="mt-5 gap-3">
          {qs.map((q, n) => (
            <Pressable
              key={q._id}
              onPress={() =>
                router.push({
                  pathname: '/play/explain',
                  params: { qid: q._id, setId: set.data._id },
                })
              }
              className="rounded-card bg-white p-5"
            >
              <View className="flex-row items-start gap-2">
                {/* 맞힌 문제는 초록, 틀린 문제는 빨강(결과를 모르면 기본색) */}
                <View
                  accessibilityLabel={`${n + 1}번 ${
                    results?.[n] === '1' ? '맞음' : results?.[n] === '0' ? '틀림' : ''
                  }`}
                  className={cx(
                    'h-5 w-5 items-center justify-center rounded-full',
                    results?.[n] === '1'
                      ? 'bg-correct'
                      : results?.[n] === '0'
                        ? 'bg-danger'
                        : 'bg-brand',
                  )}
                >
                  <Text className="text-caption2 text-white">{n + 1}</Text>
                </View>
                <Text className="flex-1 text-footnote text-ink">Q. {q.prompt}</Text>
              </View>
              <View className="mt-3 rounded-xl bg-mint px-3 py-2.5">
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
          <Animated.View entering={FADE_IN} className="mt-3 rounded-2xl bg-white px-10 py-3">
            <RollUp
              value={`+${points}P`}
              from="+0P"
              className="text-headline font-bold text-brand"
            />
          </Animated.View>
          <Text className="mt-6 text-caption2 text-white/60">탭해서 닫기</Text>
        </Pressable>
      )}
    </Canvas>
  );
}

/**
 * 퀴즈 결과의 다음 단계(FR-37): 틀린 문제는 비슷한 문제 복습(유사 퀴즈)으로, 그다음은 새 퀴즈로 잇는다.
 * 복습 날짜는 서버가 이번에 일정에 넣었을 때만 말한다(오늘의 복습 · 기기 저장은 넣지 않음).
 * 유사 퀴즈는 퀴즈를 끝내도 저절로 만들지 않는다(#625, 사용자가 누를 때만). pickFolder가 있으면 그 노트의 고르기 화면
 * (#610, 마지막 풀이에서 틀린 문제를 처음부터 체크)으로, 없으면(오늘의 복습 · 폴더가 없는 옛 세트) 이 세트로 만든다
 */
function QuizNextStep({
  setId,
  pickFolder,
  results,
  reviewDay,
  room,
}: {
  setId: string;
  pickFolder?: string;
  results?: string;
  reviewDay?: string;
  room: boolean;
}) {
  const wrong = results ? [...results].filter((r) => r === '0').length : null;
  const when = reviewDay ? reviewDayWord(reviewDay) : null;
  const line =
    wrong === null
      ? undefined
      : wrong > 0
        ? when
          ? // 이번에 일정에 넣은 문제가 틀린 문제라는 보장은 없다(이미 복습 중이던 문제는 날짜가 다름): 넣은 문제로 말한다
            `복습할 문제는 ${when} 다시 물어볼게요`
          : `틀린 ${wrong}문제, 비슷한 문제로 한 번 더 풀어 봐요`
        : when
          ? `다 맞혔어요! ${when} 한 번 더 확인해요`
          : '다 맞혔어요!';
  const steps: NextStep[] = [];
  if (wrong !== 0)
    steps.push({
      icon: Sparkles,
      label: wrong ? `틀린 ${wrong}문제 비슷한 문제로 지금 복습` : '비슷한 문제로 지금 복습',
      sub: '틀린 개념을 다른 문제로 다시 풀어요',
      onPress: () =>
        router.push({
          pathname: '/play/similar',
          params: pickFolder ? { folderId: pickFolder } : { setId },
        }),
    });
  if (!room)
    steps.push({
      icon: Plus,
      label: '다른 노트로 새 퀴즈',
      onPress: () => router.dismissTo('/(tabs)/quiz/notes'),
    });
  return <NextStepCard line={line} reviewDay={reviewDay} steps={steps} />;
}

export function QuizExplainScreen() {
  const { qid, setId, folderId } = useLocalSearchParams<{
    qid?: string;
    setId?: string;
    folderId?: string;
  }>();
  // 노트별 보관함(#601)에서 열면 그 화면이 이미 읽은 폴더 목록 캐시를 그대로 쓴다
  const box = useQuery({ ...boxQuery(folderId), enabled: !setId });
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
      <Canvas>
        <Screen>
          <Header title="AI 설명" large={false} />
          <Empty
            icon={<Brain size={ICON.lg} color={C.brand} />}
            title="설명할 문제를 불러오지 못했어요"
            body="연결을 확인하고 다시 시도해 주세요."
          >
            <Btn small onPress={() => void query.refetch()}>
              문제 다시 시도
            </Btn>
          </Empty>
        </Screen>
      </Canvas>
    );
  if (query.isPending) return <Loading />;
  if (!q)
    return (
      <Canvas>
        <Screen>
          <Header title="AI 설명" large={false} />
          <Empty
            icon={<Brain size={ICON.lg} color={C.brand} />}
            title="문제를 찾을 수 없어요"
            body="보관함에서 지웠거나 다른 기기에서 바뀐 문제예요."
          >
            <Btn small onPress={() => router.back()}>
              돌아가기
            </Btn>
          </Empty>
        </Screen>
      </Canvas>
    );
  return (
    <Canvas>
      <Screen>
        <Header title="AI 설명" large={false} />
        <View className="rounded-card bg-white">
          <View className="border-b border-line p-4">
            <Text className="text-caption font-semibold text-brand">문제 {q?.order ?? 1}</Text>
            <Text className="mt-1 text-subhead leading-6 text-ink">{q?.prompt}</Text>
          </View>
          <View className="p-4">
            {ex.isError && ex.error instanceof ApiError && ex.error.status === 503 ? (
              <AiPending what="AI 풀이 설명" />
            ) : ex.isError ? (
              <View className="items-center gap-3 py-4">
                <Text className="text-footnote text-sub">설명을 불러오지 못했어요</Text>
                <Btn small loading={ex.isFetching} onPress={() => void ex.refetch()}>
                  설명 다시 시도
                </Btn>
              </View>
            ) : ex.data ? (
              ex.data.text.split('\n').map((l) => (
                <Text
                  key={l}
                  className={cx('text-subhead leading-7 text-ink', l.startsWith('•') && 'pl-2')}
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
    </Canvas>
  );
}

/**
 * 유사 퀴즈. 퀴즈 결과 화면에서 세트를 넘기면(setId) 그 세트를 마지막으로 푼 풀이의 틀린 문제로 만든다(기존 흐름).
 * 퀴즈 홈 바로가기는 세트를 넘기지 않는다(#605): 1단계 노트(학습 폴더) 고르기 → 2단계 그 노트에서 끝낸 퀴즈의 문제
 * 고르기(SimilarPickScreen) → 고른 문제를 함께 참고해 만든다
 */
export function QuizSimilarScreen() {
  const { setId, folderId } = useLocalSearchParams<{ setId?: string; folderId?: string }>();
  if (setId) return <SimilarFromSet setId={setId} />;
  if (folderId) return <SimilarPickScreen folderId={folderId} />;
  return (
    <FolderPickScreen
      title="유사 퀴즈"
      sub="어느 노트의 문제로 만들까요?"
      all={false}
      onPick={(id) => router.push({ pathname: '/play/similar', params: { folderId: id } })}
    />
  );
}

function SimilarFromSet({ setId }: { setId: string }) {
  const making = useSimilarMaking(() => api.quiz.similar(setId));
  const { generate, poll, failed, checkFailed, waiting } = making;
  return (
    <Canvas>
      <Screen
        footer={
          <Btn
            loading={generate.isPending || waiting}
            onPress={() => (checkFailed ? void poll.refetch() : generate.mutate(undefined))}
          >
            {checkFailed
              ? '다시 확인'
              : generate.isError || failed
                ? '다시 시도'
                : '유사 퀴즈 만들기'}
          </Btn>
        }
      >
        <Header title="유사 퀴즈" large={false} />
        <Empty
          icon={<Sparkles size={ICON.lg} color={C.brand} />}
          title="틀린 문제와 비슷한 문제를 만들어요"
          body="원본과 같은 난이도로 새 문제를 만들어요. 다 만들면 바로 풀고, 마지막에 정답과 AI 해설을 볼 수 있어요."
        />
        <SimilarStatus s={making} />
      </Screen>
    </Canvas>
  );
}

/**
 * 카드는 만든 노트(학습 폴더)별로 본다(#601). 폴더 정보가 없는 예전 카드 · 지운 노트의 카드는 어느 노트에도 보이지 않고
 * 「전체 보기」(ALL_FOLDERS)에서만 보인다
 */
const inFolder = (cards: Flashcard[] | undefined, folderId: string) =>
  folderId === ALL_FOLDERS ? (cards ?? []) : (cards ?? []).filter((c) => c.folderId === folderId);

/** 보관함 쿼리: 폴더별 키는 ['quiz-box', 폴더], 전체는 ['quiz-box']라 보관함 화면과 AI 설명이 같은 캐시를 쓴다 */
const boxQuery = (folderId?: string) => {
  const folder = boxFolder(folderId);
  return {
    queryKey: folder ? ['quiz-box', folder] : ['quiz-box'],
    queryFn: () => api.quiz.box(folder),
  };
};

/** 플래시 카드: 1단계에서 노트(학습 폴더)를 고르고, 같은 화면을 그 폴더(`folderId`)로 다시 열어 그 노트의 카드를 넘겨 본다(#601) */
export function FlashScreen() {
  const { folderId } = useLocalSearchParams<{ folderId?: string }>();
  if (!folderId)
    return (
      <FolderPickScreen
        title="플래시 카드"
        onPick={(id) => router.push({ pathname: '/play/flash', params: { folderId: id } })}
      />
    );
  return <FolderFlash folderId={folderId} />;
}

function FolderFlash({ folderId }: { folderId: string }) {
  const { i: start } = useLocalSearchParams<{ i?: string }>();
  const cards = useQuery({ queryKey: ['flashcards'], queryFn: api.quiz.flashcards });
  const [i, setI] = useState(() =>
    Math.max(0, Number.isFinite(Number(start)) ? Math.floor(Number(start)) : 0),
  );
  // 카드는 문제(앞면)부터 보이고, 누르면 정답(뒷면)으로 뒤집는다
  const [back, setBack] = useState(false);
  const list = inFolder(cards.data, folderId);
  const index = Math.max(0, Math.min(i, list.length - 1));
  if (cards.isSuccess && i !== index) {
    setI(index);
    setBack(false);
  }
  const c = list[index];
  return (
    <Canvas>
      <Screen
        footer={
          list.length > 0 ? (
            <Btn
              kind="outline"
              onPress={() => router.push({ pathname: '/play/cards', params: { folderId } })}
            >
              모아보기
            </Btn>
          ) : undefined
        }
      >
        <Header
          title="플래시 카드"
          sub={list.length ? `${list.length}장` : undefined}
          large={false}
        />
        {cards.isError && !cards.data && <ErrorAlert retry={() => cards.refetch()} />}
        {cards.isPending && (
          <View accessible accessibilityLabel="카드를 불러오는 중">
            <Loading />
          </View>
        )}
        {cards.isSuccess && list.length === 0 && (
          <Empty
            icon={<Layers size={ICON.lg} color={C.brand} />}
            title="저장한 플래시 카드가 없어요"
            body={NO_CARDS}
          >
            <Btn small onPress={() => router.back()}>
              돌아가기
            </Btn>
          </Empty>
        )}
        {c && (
          <View className="mt-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="카드 뒤집기"
              onPress={() => setBack((b) => !b)}
              className="h-80 items-center justify-center rounded-card bg-white px-6"
            >
              <Animated.Text
                key={`${i}-${back}`}
                entering={FADE_IN}
                className="text-center text-title3 leading-8 font-bold text-ink"
              >
                {back ? c.back : c.front}
              </Animated.Text>
              <Text className="absolute top-4 text-caption font-semibold text-brand">
                {back ? '정답' : '문제'}
              </Text>
              <Text className="absolute bottom-4 text-caption2 text-sub">눌러서 뒤집기</Text>
            </Pressable>
          </View>
        )}
        {list.length > 0 && (
          <View className="mt-5 flex-row items-center justify-center gap-6">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="이전 카드"
              disabled={i === 0}
              onPress={() => {
                setI((x) => x - 1);
                setBack(false);
              }}
              className={cx(
                'h-11 w-11 items-center justify-center rounded-full bg-white',
                i === 0 && 'opacity-30',
              )}
            >
              <ChevronLeft size={ICON.md} color={C.ink} />
            </Pressable>
            <Text className="min-w-14 text-center text-subhead font-semibold tabular-nums text-ink">
              {i + 1} / {list.length}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="다음 카드"
              disabled={i >= list.length - 1}
              onPress={() => {
                setI((x) => x + 1);
                setBack(false);
              }}
              className={cx(
                'h-11 w-11 items-center justify-center rounded-full bg-white',
                i >= list.length - 1 && 'opacity-30',
              )}
            >
              <ChevronRight size={ICON.md} color={C.ink} />
            </Pressable>
          </View>
        )}
      </Screen>
    </Canvas>
  );
}

export function CardsScreen() {
  const { folderId } = useLocalSearchParams<{ folderId?: string }>();
  if (!folderId)
    return (
      <FolderPickScreen
        title="플래시 카드 모아보기"
        onPick={(id) => router.push({ pathname: '/play/cards', params: { folderId: id } })}
      />
    );
  return <FolderCards folderId={folderId} />;
}

function FolderCards({ folderId }: { folderId: string }) {
  const qc = useQueryClient();
  const cards = useQuery({ queryKey: ['flashcards'], queryFn: api.quiz.flashcards });
  const list = cards.data && inFolder(cards.data, folderId);
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
    <Canvas>
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
        <Header
          title="플래시 카드 모아보기"
          sub={list?.length ? `${list.length}장` : undefined}
          large={false}
          right={
            !!list?.length && (
              <Chip small on={select} onPress={() => setSelect((x) => !x)}>
                {select ? '취소' : '선택'}
              </Chip>
            )
          }
        />
        {cards.isError && !cards.data && <ErrorAlert retry={() => cards.refetch()} />}
        {cards.isPending && (
          <View accessible accessibilityLabel="카드를 불러오는 중">
            <Loading />
          </View>
        )}
        {list?.length === 0 && (
          <Empty
            icon={<Layers size={ICON.lg} color={C.brand} />}
            title="저장한 플래시 카드가 없어요"
            body={NO_CARDS}
          />
        )}
        <View className="flex-row flex-wrap justify-between gap-y-3">
          {list?.map((c, i) => (
            <Pressable
              key={c._id}
              onPress={() =>
                select
                  ? setSel((p) =>
                      p.includes(c._id) ? p.filter((x) => x !== c._id) : [...p, c._id],
                    )
                  : router.replace({ pathname: '/play/flash', params: { i: String(i), folderId } })
              }
              className={cx(
                'h-36 w-[48.5%] items-center justify-center rounded-card border bg-white p-3',
                sel.includes(c._id) ? 'border-2 border-brand' : 'border-transparent',
              )}
            >
              <Text className="text-center text-footnote font-semibold text-ink">{c.front}</Text>
            </Pressable>
          ))}
        </View>
      </Screen>
    </Canvas>
  );
}

/** 퀴즈 보관함: 1단계에서 노트(학습 폴더)를 고르고, 같은 화면을 그 폴더(`folderId`)로 다시 열어 그 노트의 보관 문제를 본다(#601) */
export function QuizBoxScreen() {
  const { folderId } = useLocalSearchParams<{ folderId?: string }>();
  if (!folderId)
    return (
      <FolderPickScreen
        title="퀴즈 보관함"
        onPick={(id) => router.push({ pathname: '/play/box', params: { folderId: id } })}
      />
    );
  return <FolderBox folderId={folderId} />;
}

function FolderBox({ folderId }: { folderId: string }) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string[]>([]);
  // 정답은 처음엔 모두 닫아 두고 「정답 보기」를 누른 문제만 펼친다.
  // 다시 불러와도 유지하고, 지운 문제는 빼서 다시 보관돼도 닫힌 채로 보인다.
  const [shown, setShown] = useState<string[]>([]);
  const remove = useMutation({
    mutationFn: (ids: string[]) => api.quiz.deleteFromBox(ids),
    onSuccess: (_, ids) => {
      qc.invalidateQueries({ queryKey: ['quiz-box'] });
      setSelected([]);
      setShown((p) => p.filter((id) => !ids.includes(id)));
      toast('선택한 퀴즈를 삭제했어요');
    },
    onError: () => toast('보관함에서 삭제하지 못했어요. 다시 시도해 주세요'),
  });
  // 키 앞부분이 ['quiz-box']라 담기 · 지우기의 무효화가 폴더별 목록에도 닿는다
  const box = useQuery(boxQuery(folderId));
  const [select, setSelect] = useState(false);
  if (box.isError && !box.data)
    return (
      <Canvas>
        <Screen>
          <Header title="퀴즈 보관함" large={false} />
          <Empty
            icon={<Archive size={ICON.lg} color={C.brand} />}
            title="보관함을 불러오지 못했어요"
            body="연결을 확인하고 다시 시도해 주세요."
          >
            <Btn small loading={box.isFetching} onPress={() => void box.refetch()}>
              다시 시도
            </Btn>
          </Empty>
        </Screen>
      </Canvas>
    );
  if (!box.data) return <Loading />;
  return (
    <Canvas>
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
        <Header
          title="퀴즈 보관함"
          sub={box.data.length ? `${box.data.length}문제` : undefined}
          large={false}
          right={
            box.data.length > 0 && (
              <Chip
                small
                on={select}
                onPress={() => {
                  setSelect((x) => !x);
                  setSelected([]);
                }}
              >
                {select ? '완료' : '선택'}
              </Chip>
            )
          }
        />
        {!box.data.length && (
          <Empty
            icon={<Archive size={ICON.lg} color={C.brand} />}
            title="보관한 퀴즈가 없어요"
            body="퀴즈를 풀고 다시 보고 싶은 문제를 보관하면 여기에 모여요."
          />
        )}
        <View className="gap-4">
          {box.data?.map((q, n) => (
            <Animated.View
              key={q._id}
              layout={LIST_LAYOUT}
              entering={FadeIn.duration(MOTION.enter)}
              exiting={FadeOut.duration(MOTION.exit)}
            >
              <View key={q._id} className="rounded-card bg-white p-4">
                <View className="flex-row items-start gap-2">
                  <View className="h-5 w-5 items-center justify-center rounded-full bg-brand">
                    <Text className="text-caption2 text-white">{n + 1}</Text>
                  </View>
                  <Text className="flex-1 text-subhead leading-6 text-ink">
                    {splitPrompt(q.prompt)[0]}
                  </Text>
                </View>
                <Passage prompt={q.prompt} mc={!!q.choices?.length} className="pl-7" />
                {!!q.choices?.length && (
                  <View className="mt-3 gap-2 pl-7">
                    {q.choices.map((c, i) => (
                      <ChoiceRow key={c} n={i} fill="bg-canvas">
                        {c}
                      </ChoiceRow>
                    ))}
                  </View>
                )}
                {shown.includes(q._id) && (
                  <Animated.View entering={FADE_IN} className="mt-2 rounded-lg bg-mint px-3 py-2">
                    <Text className="text-footnote font-semibold text-brand">
                      정답 · {q.answer}
                    </Text>
                  </Animated.View>
                )}
                <View className="mt-3 flex-row gap-2 pl-7">
                  {!shown.includes(q._id) && (
                    <Chip small onPress={() => setShown((p) => [...p, q._id])}>
                      정답 보기
                    </Chip>
                  )}
                  <Chip
                    small
                    onPress={() =>
                      router.push({ pathname: '/play/explain', params: { qid: q._id, folderId } })
                    }
                  >
                    AI 설명 보기
                  </Chip>
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
            </Animated.View>
          ))}
        </View>
      </Screen>
    </Canvas>
  );
}
