import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  TextInput,
  View,
} from 'react-native';
import Animated, {
  Extrapolation,
  FadeIn,
  ReduceMotion,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ERROR_CODES, NoteAskResult, type AiJob, NoteAskTurn } from '@notelink/shared';
import { ArrowUp } from 'lucide-react-native';
import { Text } from '@/components/text';
import { Canvas, Chip, Header, Screen, Swap, cx } from '@/components/ui';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api/http';
import { C, ICON } from '@/theme';
import { Avatar3D, type Mood } from './avatar3d';
import { useEquippedAvatar, useFocused } from './buddy';

export type Msg = {
  id: number;
  role: NoteAskTurn['role'];
  text: string;
  refs?: string[];
  error?: boolean;
  /** 학습 자료 밖 · 위험한 질문이라 답하지 않음(정해 둔 안내) */
  refused?: boolean;
};

const SUGGEST = [
  '이 노트 핵심만 알려 주세요',
  '어려운 개념을 쉽게 설명해 주세요',
  '시험에 나올 만한 내용은 뭐예요?',
];
const STATUS: Record<Mood, string> = {
  idle: '노트에서 궁금한 걸 물어보세요',
  thinking: '노트를 살펴보는 중이에요',
  talking: '설명하는 중이에요',
  happy: '노트에서 궁금한 걸 물어보세요',
};
const POLL_MS = 1500;
const WAIT_MS = 120_000; // 학교 LLM이 붐비면 길어짐. 넘으면 다시 물어보게
const HISTORY = 6; // 서버(apps/ai note/ask.py HISTORY_TURNS)와 같은 수만 보낸다
// 서버 계약(NoteAskTurn.text)의 한 턴 길이. 긴 답은 앞부분만 이력으로 보낸다
const TURN_MAX = NoteAskTurn.shape.text.maxLength ?? 600;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const active = (j: AiJob) => j.status === 'queued' || j.status === 'running';

function failText(e: unknown) {
  if (e instanceof ApiError) {
    if (e.code === ERROR_CODES.NOTE_NOT_READY) return '노트 정리가 끝나면 설명해 드릴게요.';
    // 서버에 아직 묻기 경로가 없다(#244 병합 전). 경로가 생기면 이 안내는 저절로 사라진다
    if (e.status === 404) return '아바타에게 묻기는 준비 중이에요. 곧 열려요.';
    if (e.status === 429) return '앞의 질문에 답하는 중이에요. 잠시 뒤에 물어봐 주세요.';
  }
  return '답을 만들지 못했어요. 연결을 확인하고 다시 물어봐 주세요.';
}

/** 키보드가 올라와 있는지(iOS는 올라오기 시작할 때 바로 바꿔 무대가 함께 비켜 서게).
 * 안드로이드에는 Will 이벤트가 없어 Did로 받는다 */
function useKeyboardShown() {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const IOS = Platform.OS === 'ios';
    const on = Keyboard.addListener(IOS ? 'keyboardWillShow' : 'keyboardDidShow', () =>
      setShown(true),
    );
    const off = Keyboard.addListener(IOS ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setShown(false),
    );
    return () => {
      on.remove();
      off.remove();
    };
  }, []);
  return shown;
}

const BIG = 190;
const SMALL = 60;
const STAGE = { big: BIG + 30, small: SMALL + 16 };

/**
 * 아바타 무대. 대화가 시작되거나 키보드가 올라오면 아바타가 오른쪽 위 모서리로 호를 그리며
 * "슉" 작아지고, 무대가 함께 줄어 대화가 보일 자리를 비운다. 크기와 자리가 한 번에 움직이고
 * 도착은 길게 감속한다(stageshow motion.md: 커지거나 작아지며 이동하면 긴 감속).
 */
function TutorStage({
  mood,
  avatarId,
  compact,
}: {
  mood: Mood;
  avatarId: string;
  compact: boolean;
}) {
  const [w, setW] = useState(0);
  const focused = useFocused();
  const p = useSharedValue(compact ? 1 : 0);
  useEffect(() => {
    p.set(
      withSpring(compact ? 1 : 0, {
        duration: 680,
        dampingRatio: 0.74,
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [compact, p]);

  const box = useAnimatedStyle(() => ({
    height: interpolate(p.get(), [0, 1], [STAGE.big, STAGE.small]),
  }));
  const fly = useAnimatedStyle(() => {
    const t = p.get();
    const mid = Math.sin(Math.PI * Math.min(1, Math.max(0, t))); // 가는 길의 한가운데서 1
    return {
      transform: [
        { translateX: interpolate(t, [0, 1], [0, w / 2 - 16 - SMALL / 2]) },
        // 곧장 가지 않고 위로 살짝 떠올랐다 내려앉는 호
        {
          translateY: interpolate(t, [0, 1], [0, STAGE.small / 2 - (8 + BIG / 2)]) - mid * 14,
        },
        { rotate: `${mid * (compact ? 12 : -12)}deg` },
        { scale: interpolate(t, [0, 1], [1, SMALL / BIG], Extrapolation.EXTEND) },
      ],
    };
  });
  const bigText = useAnimatedStyle(() => ({
    opacity: interpolate(p.get(), [0, 0.4], [1, 0], Extrapolation.CLAMP),
  }));
  const smallText = useAnimatedStyle(() => ({
    opacity: interpolate(p.get(), [0.5, 1], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(p.get(), [0.5, 1], [8, 0], Extrapolation.CLAMP) }],
  }));

  return (
    <Animated.View
      // 날아가는 동안 3D 화면의 네모난 바탕이 무대 밖으로 비치지 않게 자른다
      className="overflow-hidden rounded-card bg-mint"
      style={box}
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
    >
      <Animated.View className="absolute top-2" style={[{ left: (w - BIG) / 2 }, fly]}>
        {/* 퀴즈처럼 다른 화면이 위에 쌓이면 3D를 내려 그리기 반복을 멈춘다 */}
        {focused && <Avatar3D mood={mood} avatarId={avatarId} size={BIG} />}
      </Animated.View>
      <Animated.View className="absolute inset-x-0 bottom-2.5 items-center" style={bigText}>
        <Swap k={mood}>
          <Text className="text-caption text-sub">{STATUS[mood]}</Text>
        </Swap>
      </Animated.View>
      <Animated.View
        className="absolute top-0 bottom-0 left-4 justify-center"
        style={smallText}
        pointerEvents="none"
      >
        <Text className="text-caption2 text-sub">아바타 선생님</Text>
        <Swap k={mood}>
          <Text className="text-footnote font-semibold text-ink">{STATUS[mood]}</Text>
        </Swap>
      </Animated.View>
    </Animated.View>
  );
}

/** 답을 말하듯 앞에서부터 보여 준다. 다 보이면 onDone(아바타가 입을 닫음) */
function Typing({ text, onDone }: { text: string; onDone: () => void }) {
  const [n, setN] = useState(0);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    // 접근성 설정을 읽는 사이 화면을 떠났으면 타이머를 만들지도, 끝났다고 알리지도 않는다
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (!alive) return;
      if (reduce) {
        setN(text.length);
        done.current();
        return;
      }
      let shown = 0;
      timer = setInterval(() => {
        shown = Math.min(text.length, shown + 2);
        setN(shown);
        if (shown === text.length) {
          clearInterval(timer);
          done.current();
        }
      }, 45);
    });
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [text]);
  return (
    <Text className="text-footnote text-ink" accessibilityLabel={text}>
      {text.slice(0, n)}
    </Text>
  );
}

/** 마지막 답이 학습 자료로 한 답이면 다음 학습을 권한다 */
const nextStep = (msgs: Msg[]) => {
  const last = msgs[msgs.length - 1];
  return !!last && last.role === 'avatar' && !last.error && !last.refused;
};

/**
 * 답을 받은 뒤 이어서 물어볼 추천 질문: 아직 답을 받지 못한 것만. 오류로 끝난 질문(연결 · 정리 전 등)은
 * 물은 것으로 치지 않아 칩으로 다시 보여 주고, 거절(자료 밖)은 정해 둔 답을 받은 것이라 뺀다
 */
export const nextSuggest = (msgs: Msg[]) => {
  if (msgs[msgs.length - 1]?.role !== 'avatar') return [];
  const answered = new Set(
    msgs.flatMap((m, i) => {
      const reply = msgs[i + 1];
      return m.role === 'user' && reply?.role === 'avatar' && !reply.error ? [m.text] : [];
    }),
  );
  return SUGGEST.filter((q) => !answered.has(q));
};

/** 아바타 선생님: 정리된 노트(녹음 · 문서 · 필기)를 옆에서 설명한다 */
export function TutorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const mat = useQuery({ queryKey: ['material', id], queryFn: () => api.content.material(id) });
  const qc = useQueryClient();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [v, setV] = useState('');
  const [mood, setMood] = useState<Mood>('idle');
  const [live, setLive] = useState<number | null>(null); // 지금 말하는 답
  const alive = useRef(true);
  const seq = useRef(0);
  const list = useRef<FlatList<Msg>>(null);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const avatar = useEquippedAvatar();
  const keyboard = useKeyboardShown();
  const busy = mood !== 'idle';
  const say = (m: Omit<Msg, 'id'>) => {
    const msg = { ...m, id: ++seq.current };
    setMsgs((all) => [...all, msg]);
    return msg.id;
  };

  const ask = async (raw: string) => {
    const question = raw.trim();
    if (!question || busy) return;
    setV('');
    const history = msgs
      .filter((m) => !m.error)
      .slice(-HISTORY)
      .map(({ role, text }) => ({ role, text: text.slice(0, TURN_MAX) }));
    say({ role: 'user', text: question });
    setMood('thinking');
    try {
      let job = await api.content.ask(id, { question, history });
      const until = Date.now() + WAIT_MS;
      while (active(job) && Date.now() < until && alive.current) {
        await sleep(POLL_MS);
        job = await api.ai.job(job._id);
      }
      if (!alive.current) return;
      const result = job.status === 'succeeded' ? NoteAskResult.safeParse(job.result) : null;
      if (!result?.success) throw new Error(job.status);
      // 답 하나에 AI 크레딧을 썼다: 설정의 사용량이 바로 맞게 내 정보를 다시 읽는다
      void qc.invalidateQueries({ queryKey: ['me'] });
      const { answer, refs, answerable } = result.data;
      setLive(say({ role: 'avatar', text: answer, refs, refused: !answerable }));
      setMood('talking');
    } catch (e) {
      if (!alive.current) return;
      say({ role: 'avatar', text: failText(e), error: true });
      setMood('idle');
    }
  };

  return (
    <Canvas>
      <Screen
        scroll={false}
        footer={
          <View className="flex-row items-center rounded-full bg-white pr-1.5 pl-4">
            <TextInput
              value={v}
              onChangeText={setV}
              onSubmitEditing={() => void ask(v)}
              returnKeyType="send"
              placeholder="노트에 대해 물어보기"
              placeholderTextColor={C.sub}
              maxLength={500}
              className="h-11 flex-1 text-subhead text-ink"
            />
            <Pressable
              accessibilityLabel="질문 보내기"
              accessibilityState={{ disabled: busy || !v.trim() }}
              onPress={() => void ask(v)}
              hitSlop={8}
              className={cx(
                'h-8 w-8 items-center justify-center rounded-full',
                busy || !v.trim() ? 'bg-fill' : 'bg-brand',
              )}
            >
              <ArrowUp size={ICON.sm} color={busy || !v.trim() ? C.sub : '#fff'} />
            </Pressable>
          </View>
        }
      >
        <Header title="아바타 선생님" sub={mat.data?.title} large={false} />
        <TutorStage mood={mood} avatarId={avatar} compact={msgs.length > 0 || keyboard} />
        <FlatList
          ref={list}
          className="mt-3 flex-1"
          data={msgs}
          keyExtractor={(m) => String(m.id)}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
          contentContainerClassName="gap-3 pb-4"
          // 에이전트처럼 다음 학습으로 잇는다: 자료로 답한 뒤 퀴즈(학습 확인) · 복습으로
          ListFooterComponent={
            live === null && (nextStep(msgs) || nextSuggest(msgs).length > 0) ? (
              <Animated.View entering={FadeIn.duration(220)} className="flex-row flex-wrap gap-2">
                {/* 하나를 물은 뒤에도 남은 추천 질문을 다음 질문으로 이어 준다 */}
                {nextSuggest(msgs).map((q) => (
                  <Chip key={q} small disabled={busy} onPress={() => void ask(q)}>
                    {q}
                  </Chip>
                ))}
                {nextStep(msgs) && (
                  <>
                    <Chip
                      small
                      onPress={() =>
                        router.push({
                          pathname: '/play/gen',
                          params: { materialId: id, title: mat.data?.title ?? '' },
                        })
                      }
                    >
                      이 노트로 퀴즈 풀기
                    </Chip>
                    <Chip small onPress={() => router.push('/quiz')}>
                      복습하러 가기
                    </Chip>
                  </>
                )}
              </Animated.View>
            ) : null
          }
          ListEmptyComponent={
            <View className="flex-row flex-wrap gap-2">
              {SUGGEST.map((q) => (
                <Chip key={q} small onPress={() => void ask(q)}>
                  {q}
                </Chip>
              ))}
            </View>
          }
          renderItem={({ item: m }) => (
            <Animated.View
              entering={FadeIn.duration(180)}
              className={cx('flex-row', m.role === 'user' && 'justify-end')}
            >
              <View
                className={cx(
                  'max-w-[85%] gap-1.5 rounded-2xl px-3.5 py-2',
                  m.role === 'user' ? 'bg-brand' : 'bg-white',
                )}
              >
                {m.role === 'user' ? (
                  <Text className="text-footnote text-white">{m.text}</Text>
                ) : m.id === live ? (
                  <Typing
                    text={m.text}
                    onDone={() => {
                      setLive(null);
                      setMood('idle');
                    }}
                  />
                ) : (
                  <Text
                    className={cx('text-footnote', m.error || m.refused ? 'text-sub' : 'text-ink')}
                  >
                    {m.text}
                  </Text>
                )}
                {!!m.refs?.length && m.id !== live && (
                  <Text className="text-caption2 text-sub">근거 · {m.refs.join(', ')}</Text>
                )}
              </View>
            </Animated.View>
          )}
        />
      </Screen>
    </Canvas>
  );
}
