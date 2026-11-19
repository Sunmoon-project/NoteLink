import { useEffect, useMemo, useRef, useState } from 'react';
import type { Material } from '@notelink/shared';
import { aiStateOf, type AiState } from '@/lib/ai';
import { ScrollView, View } from 'react-native';
import { Pressable } from '@/components/press';
import { Text } from '@/components/text';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { router, useIsFocused } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as SecureStore from 'expo-secure-store';
import { Bookmark, Pause, Play, Repeat, Sparkles } from 'lucide-react-native';
import { api } from '@/lib/api';
import { paragraphs, rangeAt, segmentsIn } from '@/lib/transcript';
import { toast } from '@/stores/toast';
import { Avatar3D } from '@/features/tutor/avatar3d';
import { canAsk, useEquippedAccessories, useEquippedAvatar } from '@/features/tutor/buddy';
import { CLOSED, lipsAt } from '@/features/tutor/lips';
import { splitLines } from './captions';
import { Captions } from './captions-view';
import { usePlaybackClock } from './clock';
import { Btn, Chip, Loading, Sheet, cx } from '@/components/ui';
import { C, ICON } from '@/theme';

// p.66 #22 · p.69 녹음 요약 재생 · 아바타 립싱크 · 북마크 · 원문 텍스트

const mmss = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const hhmmss = (s: number) => new Date(Math.max(0, s) * 1000).toISOString().slice(11, 19);
const SPEEDS = [1, 1.25, 1.5, 2];

/** 실제 녹음 파일을 expo-audio로 재생한다. 길이는 서버 값이 없으면 파일에서 읽는다 */
function usePlayback(url: string | undefined, knownDuration: number) {
  // 상태는 0.25초마다(기본 0.5초). 그 사이는 usePlaybackClock이 프레임마다 이어 붙인다
  const player = useAudioPlayer(url ? { uri: url } : null, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  // 탭 안의 스택 화면은 탭을 바꾸거나 다른 화면을 올려도 내려가지 않아 소리가 계속 났다 → 가려지면 일시정지
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) player.pause();
  }, [focused, player]);
  const duration = knownDuration || status.duration || 0;
  return {
    ready: !!url,
    duration,
    pos: status.currentTime,
    playing: status.playing,
    buffering: status.isBuffering,
    rate: status.playbackRate || 1,
    loop: player.loop,
    toggle: () => (status.playing ? player.pause() : player.play()),
    pause: () => player.pause(),
    seek: (s: number) => player.seekTo(Math.max(0, Math.min(duration, s))),
    setRate: (r: number) => player.setPlaybackRate(r),
    // expo-audio는 loop를 속성으로만 바꾼다
    // eslint-disable-next-line react-hooks/immutability
    setLoop: (l: boolean) => (player.loop = l),
  };
}

const posKey = (materialId: string) => `notelink.playpos.${materialId}`;
const RESUME_MARGIN = 5; // 처음 · 끝 5초 안이면 이어듣지 않는다(거의 처음이거나 다 들음)

/**
 * 이어듣기(설정 「이어듣기」): 켜져 있으면 녹음마다 멈춘 자리를 기기에 적어 두고, 다시 열면 그 자리부터.
 * 끝까지 들었으면 처음부터. 꺼져 있으면 읽지도 적지도 않는다
 */
export function useResume(
  materialId: string,
  p: { ready: boolean; duration: number; pos: number; seek: (s: number) => void },
) {
  // 내 설정은 다른 화면과 같은 ['me'] 캐시를 쓴다
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me.get() });
  const on = me.data?.settings.resumePlayback ?? false;
  const restored = useRef(false);
  const reading = useRef(false);
  // 화면을 떠났으면 읽기 결과로 닫힌 플레이어를 옮기거나 알리지 않는다(#366 리뷰)
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const saved = useRef(-1);
  const latest = useRef({ on, pos: p.pos, duration: p.duration });
  useEffect(() => {
    latest.current = { on, pos: p.pos, duration: p.duration };
  });
  const write = (pos: number, duration: number) => {
    const at = duration && pos >= duration - RESUME_MARGIN ? 0 : Math.floor(pos);
    if (at === saved.current) return;
    saved.current = at;
    void SecureStore.setItemAsync(posKey(materialId), String(at)).catch(() => {});
  };
  // 길이를 알게 되면 한 번 지난 자리로 옮긴다
  useEffect(() => {
    if (!on || reading.current || restored.current || !p.ready || !p.duration) return;
    // 읽기를 마친 뒤에만 「복원됨」으로 둔다. 읽는 동안 화면을 닫으면 아무것도 적지 않아,
    // 지금 자리(0초)로 지난 자리를 덮어쓰지 않는다(#366 리뷰)
    reading.current = true;
    void SecureStore.getItemAsync(posKey(materialId))
      .then((v) => {
        if (!alive.current) return;
        const at = Number(v);
        if (at > RESUME_MARGIN && at < p.duration - RESUME_MARGIN) {
          saved.current = at;
          p.seek(at);
          toast(`지난번 ${mmss(at)}부터 이어서 들어요`);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (alive.current) restored.current = true;
      });
  }, [on, p.ready, p.duration]); // eslint-disable-line react-hooks/exhaustive-deps
  // 듣는 동안 5초마다, 화면을 떠날 때 한 번 더 적는다
  useEffect(() => {
    if (on && restored.current && Math.abs(p.pos - Math.max(0, saved.current)) >= 5)
      write(p.pos, p.duration);
  }, [on, p.pos]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      const l = latest.current;
      if (l.on && restored.current) write(l.pos, l.duration);
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
}

/** 대본이 없을 때 처리 상태별 안내 — 서버 모드에서 실패 · 빈 녹음에도 「서버가 연결되면」이 나왔다(develop 점검 #4) */
const NO_TRANSCRIPT: Record<AiState, string> = {
  failed: '대본을 만들지 못했어요. 원본 녹음은 지금 들을 수 있어요.',
  working: '대본을 만들고 있어요. 원본 녹음은 지금 들을 수 있어요.',
  done: '녹음에서 말한 내용을 찾지 못했어요.',
  waiting: '대본은 AI 서버가 연결되면 음성 인식으로 만들어져요. 원본 녹음은 지금 들을 수 있어요.',
};

export function Player({
  materialId,
  initialView = 'summary',
  openBookmarks = false,
}: {
  materialId: string;
  initialView?: 'summary' | 'text';
  openBookmarks?: boolean;
}) {
  const qc = useQueryClient();
  const rec = useQuery({
    queryKey: ['recording', materialId],
    queryFn: () => api.content.recording(materialId),
    // 서버가 대본을 만드는 중이면 끝날 때까지 다시 읽는다(「만들고 있어요」에 멈춰 있지 않게)
    refetchInterval: () =>
      aiStateOf(qc.getQueryData<Material>(['material', materialId])?.processing) === 'working'
        ? 3000
        : false,
  });
  const mat = useQuery({
    queryKey: ['material', materialId],
    queryFn: () => api.content.material(materialId),
  });
  const p = usePlayback(rec.data?.audioUrl || undefined, rec.data?.durationSec ?? 0);
  useResume(materialId, p);
  const duration = p.duration;
  const percent = (sec: number) => `${duration ? (sec / duration) * 100 : 0}%` as const;
  const [view, setView] = useState(initialView);
  const [sheet, setSheet] = useState(openBookmarks);
  const [marks, setMarks] = useState<number[]>([]);
  const [barW, setBarW] = useState(1);
  // 저장된 북마크를 불러오면 목록을 채운다 (렌더 중 상태 조정)
  const [loaded, setLoaded] = useState<typeof mat.data>();
  if (mat.data && mat.data !== loaded) {
    setLoaded(mat.data);
    setMarks(mat.data.bookmarks.map((b) => b.atSec));
  }

  const slide = rec.data?.slides.find((s) => p.pos >= s.startSec && p.pos < s.endSec);
  const segs = rec.data?.transcript.segments ?? [];
  // 요약 화면 아래 대본은 지금 슬라이드(또는 슬라이드 사이 구간)의 문장만. 전체를 한 덩어리로 보이면
  // 42분 녹음은 읽을 수 없었다. 전체 대본은 「대본」 화면에서 슬라이드별 문단으로 본다
  const range = rangeAt(rec.data?.slides ?? [], p.pos);
  // 한 문장씩 띄운다(긴 구간도 상자가 짧게). 구간 끝에서는 다음 구간의 첫 문장을 미리 보인다
  const [lines, then] = useMemo(() => {
    const all = rec.data?.transcript.segments ?? [];
    const next = all
      .filter((s) => s.startSec >= range.hi)
      .reduce<(typeof all)[number] | undefined>(
        (a, s) => (!a || s.startSec < a.startSec ? s : a),
        undefined,
      );
    return [
      splitLines(segmentsIn(all, range.lo, range.hi)),
      next ? splitLines([next])[0] : undefined,
    ] as const;
  }, [rec.data, range.lo, range.hi]);
  // 버퍼링 중에는 소리가 멈춰 있으니 시계도 세운다(앞질러 달렸다가 뒤로 튀지 않게)
  const { clock, posNow } = usePlaybackClock({
    pos: p.pos,
    rate: p.rate,
    playing: p.playing && !p.buffering,
  });
  const avatar = useEquippedAvatar();
  const acc = useEquippedAccessories();
  const marking = useRef(false);
  const addMark = async () => {
    if (marking.current) return;
    marking.current = true;
    const at = p.pos;
    try {
      await api.content.addBookmark(materialId, at);
      qc.setQueryData<Awaited<ReturnType<typeof api.content.material>>>(
        ['material', materialId],
        (current) =>
          current
            ? {
                ...current,
                bookmarks: current.bookmarks.some((b) => b.atSec === at)
                  ? current.bookmarks
                  : [...current.bookmarks, { atSec: at }],
              }
            : current,
      );
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setMarks((m) => [...new Set([...m, at])].sort((a, b) => a - b));
      toast(`${hhmmss(at)} 구간을 북마크했어요`);
    } catch {
      toast('북마크를 저장하지 못했어요. 다시 시도해 주세요');
    } finally {
      marking.current = false;
    }
  };
  if ((mat.isError && !mat.data) || (rec.isError && !rec.data))
    return (
      <View className="gap-3 p-4">
        <Text>재생 자료를 불러오지 못했어요</Text>
        <Btn
          loading={mat.isFetching || rec.isFetching}
          onPress={() => {
            if (mat.isError) void mat.refetch();
            if (rec.isError) void rec.refetch();
          }}
        >
          다시 시도
        </Btn>
      </View>
    );
  if (!mat.data || !rec.data) return <Loading />;
  // 정리가 끝난 자료만 선생님에게 물을 수 있다(떠 있는 아바타와 같은 조건)
  const ask = canAsk(mat.data);
  return (
    <>
      <View className="rounded-3xl bg-night p-3">
        {view === 'summary' ? (
          <>
            <View className="relative rounded-2xl bg-white/5 p-4">
              {slide ? (
                <>
                  <Text className="text-caption2 text-white/60">
                    슬라이드 {slide.index + 1} / {rec.data.slides.length}
                  </Text>
                  <Text className="mt-1 text-callout font-bold text-white">{slide.title}</Text>
                  <View className="mt-2 flex-row items-end justify-between">
                    <View className="gap-0.5">
                      {slide.bullets.map((b) => (
                        <Text key={b} className="text-caption2 text-white/60">
                          • {b}
                        </Text>
                      ))}
                    </View>
                  </View>
                </>
              ) : (
                <Text className="text-caption text-white/60">
                  이 구간에는 요약 슬라이드가 없어요
                </Text>
              )}
            </View>
            <View className="mt-3 rounded-lg border border-white/10 p-3">
              <View className="flex-row items-center gap-1.5">
                <Sparkles size={ICON.xs} color={'#fff'} />
                <Text className="text-caption2 font-semibold text-white">
                  {p.playing ? '아바타 립싱크 재생 중' : '아바타 립싱크 일시정지'}
                </Text>
              </View>
              <View className="mt-2 flex-row gap-3">
                {/* 말하는 사람과 글이 붙어 보이게 자막 왼쪽에. 입은 단어 시각 · 한글 모음으로 맞춘다 */}
                {/* 누르면 이 자료의 선생님 대화(떠 있는 아바타 대신 여기가 입구). 소리가 겹치지 않게 재생은 먼저 멈춘다 */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="아바타 선생님에게 물어보기"
                  disabled={!ask}
                  onPress={() => {
                    p.pause();
                    void Haptics.selectionAsync().catch(() => {});
                    router.push({ pathname: '/tutor/[id]', params: { id: materialId } });
                  }}
                  className="items-center self-start"
                >
                  <View className="h-16 w-16 overflow-hidden rounded-2xl">
                    <Avatar3D
                      mood={p.playing ? 'talking' : 'idle'}
                      avatarId={avatar}
                      accessories={acc}
                      size={64}
                      // head 구도는 얼굴을 꽉 채워 둥근 상자에서 귀 · 볼이 잘렸다 → 여백 있는 전체 구도
                      framing="full"
                      background={C.night}
                      lips={() => (p.playing ? lipsAt(lines, posNow()) : CLOSED)}
                    />
                  </View>
                  {ask && <Text className="mt-1 text-caption2 text-white/60">물어보기</Text>}
                </Pressable>
                <View className="flex-1 justify-center">
                  {lines.length ? (
                    <Captions lines={lines} clock={clock} pos={p.pos} then={then} />
                  ) : (
                    <Text className="text-caption leading-5 text-white/60">
                      {segs.length
                        ? '이 구간에는 말한 내용이 없어요'
                        : NO_TRANSCRIPT[aiStateOf(mat.data?.processing)]}
                    </Text>
                  )}
                </View>
              </View>
            </View>
          </>
        ) : (
          <ScrollView className="max-h-64 p-3" nestedScrollEnabled>
            <Text className="text-footnote font-bold text-white">전체 대본</Text>
            {segs.length ? (
              // 슬라이드별 문단(제목 · 시작 시각). 문단을 누르면 그 시각으로 옮겨 요약 슬라이드와 맞춰 볼 수 있다
              paragraphs(rec.data.slides, segs).map((para) => (
                <Pressable
                  key={para.key}
                  accessibilityRole="button"
                  accessibilityLabel={`${mmss(para.startSec)} ${para.title ?? '구간'}으로 이동`}
                  onPress={() => p.seek(para.startSec)}
                  className="mt-3"
                >
                  <Text className="text-caption2 font-semibold text-white/50">
                    {mmss(para.startSec)}
                    {para.title ? ` · ${para.title}` : ''}
                  </Text>
                  <Text className="mt-0.5 text-caption leading-5 text-white/80">
                    {para.segments.map((s) => s.text).join(' ')}
                  </Text>
                </Pressable>
              ))
            ) : (
              <Text className="mt-2 text-caption leading-5 text-white/80">
                {rec.data?.transcript.text || '아직 대본이 없어요 · AI 서버 연결 후 만들어져요'}
              </Text>
            )}
          </ScrollView>
        )}

        <Pressable
          className="mt-4 h-6 justify-center px-1"
          onLayout={(e) => setBarW(e.nativeEvent.layout.width)}
          onPress={(e) => p.seek((e.nativeEvent.locationX / barW) * duration)}
        >
          <View className="h-1 rounded-full bg-white/20">
            <View className="h-1 rounded-full bg-white" style={{ width: percent(p.pos) }} />
          </View>
          {marks.map((m) => (
            <View
              key={m}
              className="absolute top-2 h-1.5 w-1.5 rounded-full bg-sun"
              style={{ left: percent(m) }}
            />
          ))}
          <View
            className="absolute h-4 w-4 rounded-full bg-white"
            style={{ left: percent(p.pos), marginLeft: -4 }}
          />
        </Pressable>
        <View className="flex-row items-center justify-between px-1">
          <Text className="tabular-nums text-caption2 text-white/60">
            {mmss(p.pos)} / {mmss(duration)}
          </Text>
          <Pressable
            onPress={() => p.setRate(SPEEDS[(SPEEDS.indexOf(p.rate) + 1) % SPEEDS.length] ?? 1)}
            // 보이는 칩은 32, 위아래 6씩 넓혀 누르는 높이 44(시간 줄 높이는 거의 그대로)
            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
            className="h-8 justify-center rounded-full bg-white/15 px-3"
          >
            <Text className="text-caption font-semibold text-white">{p.rate}x 배속</Text>
          </Pressable>
        </View>
        <View className="mt-2 flex-row items-center justify-center gap-3 pb-1">
          <Pressable
            accessibilityLabel="북마크 추가"
            onPress={addMark}
            className="h-12 w-12 items-center justify-center rounded-full bg-white"
          >
            <Bookmark size={ICON.md} color={C.danger} />
          </Pressable>
          <Pressable
            accessibilityLabel="5초 뒤로"
            onPress={() => p.seek(p.pos - 5)}
            className="h-12 w-12 items-center justify-center rounded-full bg-white/10"
          >
            <Text className="text-footnote font-bold text-white">◀5</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={p.playing ? '일시정지' : '재생'}
            onPress={p.toggle}
            className="h-14 w-14 items-center justify-center rounded-full bg-white"
          >
            {p.playing ? (
              <Pause size={ICON.lg} color={C.ink} />
            ) : (
              <Play size={ICON.lg} color={C.ink} />
            )}
          </Pressable>
          <Pressable
            accessibilityLabel="5초 앞으로"
            onPress={() => p.seek(p.pos + 5)}
            className="h-12 w-12 items-center justify-center rounded-full bg-white/10"
          >
            <Text className="text-footnote font-bold text-white">5▶</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="구간 반복"
            onPress={() => p.setLoop(!p.loop)}
            className={cx(
              'h-12 w-12 items-center justify-center rounded-full',
              p.loop ? 'bg-sun' : 'bg-brand',
            )}
          >
            <Repeat size={ICON.md} color={p.loop ? C.ink : '#fff'} />
          </Pressable>
        </View>
      </View>
      <View className="mt-3 flex-row gap-2">
        <Chip small onPress={() => setView((v) => (v === 'summary' ? 'text' : 'summary'))}>
          {view === 'summary' ? '원문 텍스트 보기' : '요약 보기'}
        </Chip>
        <Chip small onPress={() => setSheet(true)}>{`북마크 모음 (${marks.length})`}</Chip>
      </View>
      <Sheet open={sheet} onClose={() => setSheet(false)} title="북마크 모음">
        <View className="gap-2">
          {marks.map((m, i) => (
            <Pressable
              key={`${m}-${i}`}
              onPress={() => {
                p.seek(m);
                setSheet(false);
              }}
              className="flex-row items-center gap-3 rounded-xl bg-fill px-4 py-3"
            >
              <View className="h-3 w-3 rounded-sm bg-brand" />
              <Text className="flex-1 tabular-nums text-footnote text-ink">{hhmmss(m)}</Text>
              <Text className="text-caption2 text-sub">구간 {i + 1}</Text>
            </Pressable>
          ))}
        </View>
      </Sheet>
    </>
  );
}
