import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Text } from '@/components/text';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import { Bookmark, Pause, Play, Repeat, Sparkles } from 'lucide-react-native';
import { api } from '@/lib/api';
import { toast } from '@/stores/toast';
import { Btn, Chip, Loading, Sheet, cx } from '@/components/ui';
import { C, ICON } from '@/theme';

// p.66 #22 · p.69 녹음 요약 재생 · 아바타 립싱크 · 북마크 · 원문 텍스트

const mmss = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const hhmmss = (s: number) => new Date(Math.max(0, s) * 1000).toISOString().slice(11, 19);
const SPEEDS = [1, 1.25, 1.5, 2];

/** 재생 위치 소스: 오디오 주소가 있으면 expo-audio, 없으면(목업) 시계로 흉내 */
function usePlayback(url: string | undefined, duration: number) {
  const player = useAudioPlayer(url ? { uri: url } : null);
  const status = useAudioPlayerStatus(player);
  const [sim, setSim] = useState({ pos: 134, playing: true, rate: 1, loop: false });
  useEffect(() => {
    if (url || !sim.playing) return;
    const id = setInterval(
      () =>
        setSim((s) => {
          const n = s.pos + s.rate;
          return n >= duration
            ? s.loop
              ? { ...s, pos: 0 }
              : { ...s, pos: duration, playing: false }
            : { ...s, pos: n };
        }),
      1000,
    );
    return () => clearInterval(id);
  }, [url, sim.playing, sim.rate, duration]);
  if (url) {
    return {
      pos: status.currentTime,
      playing: status.playing,
      rate: status.playbackRate,
      loop: player.loop,
      toggle: () => (status.playing ? player.pause() : player.play()),
      seek: (s: number) => player.seekTo(Math.max(0, Math.min(duration, s))),
      setRate: (r: number) => player.setPlaybackRate(r),
      // expo-audio는 loop를 속성으로만 바꾼다
      // eslint-disable-next-line react-hooks/immutability
      setLoop: (l: boolean) => (player.loop = l),
    };
  }
  return {
    ...sim,
    toggle: () => setSim((s) => ({ ...s, playing: !s.playing })),
    seek: (p: number) => setSim((s) => ({ ...s, pos: Math.max(0, Math.min(duration, p)) })),
    setRate: (rate: number) => setSim((s) => ({ ...s, rate })),
    setLoop: (loop: boolean) => setSim((s) => ({ ...s, loop })),
  };
}

/** 아바타 입 모양 — 서버의 viseme(입 모양 9종) 연결 전까지 재생 중에 여닫는다 */
function LipSyncAvatar({ playing }: { playing: boolean }) {
  const open = useSharedValue(0.4);
  useEffect(() => {
    if (playing) open.value = withRepeat(withTiming(1.6, { duration: 280 }), -1, true);
    else {
      cancelAnimation(open);
      open.value = withTiming(0.4);
    }
  }, [playing]); // eslint-disable-line react-hooks/exhaustive-deps
  const mouth = useAnimatedStyle(() => ({ transform: [{ scaleY: open.value }] }));
  return (
    <View
      accessibilityLabel="아바타"
      className="absolute right-3 -bottom-6 h-14 w-14 items-center justify-center rounded-full border-4 border-night bg-brand"
    >
      <View className="flex-row gap-2.5">
        <View className="h-1.5 w-1.5 rounded-full bg-white" />
        <View className="h-1.5 w-1.5 rounded-full bg-white" />
      </View>
      <Animated.View className="mt-1.5 h-1.5 w-3 rounded-full bg-white" style={mouth} />
    </View>
  );
}

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
  });
  const mat = useQuery({
    queryKey: ['material', materialId],
    queryFn: () => api.content.material(materialId),
  });
  const duration = rec.data?.durationSec ?? 340;
  const p = usePlayback(rec.data?.audioUrl || undefined, duration);
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

  const slide =
    rec.data?.slides.find((s) => p.pos >= s.startSec && p.pos < s.endSec) ?? rec.data?.slides[2];
  const segs = rec.data?.transcript.segments ?? [];
  const cap = segs.findIndex((s) => p.pos >= s.startSec && p.pos < s.endSec);
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
  if (mat.isError || rec.isError)
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
  return (
    <>
      <View className="rounded-3xl bg-night p-3">
        {view === 'summary' ? (
          <>
            <View className="relative rounded-2xl bg-white/5 p-4">
              <Text className="text-caption2 text-white/50">
                슬라이드 {(slide?.index ?? 2) + 1} / {rec.data?.slides.length ?? 8}
              </Text>
              <Text className="mt-1 text-callout font-bold text-white">
                {slide?.title ?? '이온화 에너지 주기적 경향성'}
              </Text>
              <View className="mt-2 flex-row items-end justify-between">
                <View className="gap-0.5">
                  {(slide?.bullets ?? []).map((b) => (
                    <Text key={b} className="text-caption2 text-white/60">
                      • {b}
                    </Text>
                  ))}
                </View>
                <View className="flex-row items-end gap-1 pr-14">
                  {[18, 26, 32, 22, 38].map((h, i) => (
                    <View key={i} className="w-3 rounded-sm bg-brand" style={{ height: h }} />
                  ))}
                </View>
              </View>
              <LipSyncAvatar playing={p.playing} />
            </View>
            <View className="mt-8 rounded-lg border border-white/10 p-3">
              <View className="flex-row items-center gap-1.5">
                <Sparkles size={ICON.xs} color={'#fff'} />
                <Text className="text-caption2 font-semibold text-white">
                  아바타 립싱크 재생 중
                </Text>
              </View>
              <Text className="mt-1 text-caption leading-5 text-white/50">
                {segs.map((s, i) => (
                  <Text key={i} className={cx(i === cap && 'font-bold text-white')}>
                    {s.text}{' '}
                  </Text>
                ))}
              </Text>
            </View>
          </>
        ) : (
          <ScrollView className="max-h-64 p-3" nestedScrollEnabled>
            <Text className="text-footnote font-bold text-white">전체 대본</Text>
            <Text className="mt-2 text-caption leading-5 text-white/80">
              {rec.data?.transcript.text}
            </Text>
          </ScrollView>
        )}

        <Pressable
          className="mt-4 h-6 justify-center px-1"
          onLayout={(e) => setBarW(e.nativeEvent.layout.width)}
          onPress={(e) => p.seek((e.nativeEvent.locationX / barW) * duration)}
        >
          <View className="h-1 rounded-full bg-white/20">
            <View
              className="h-1 rounded-full bg-white"
              style={{ width: `${(p.pos / duration) * 100}%` }}
            />
          </View>
          {marks.map((m) => (
            <View
              key={m}
              className="absolute top-2 h-1.5 w-1.5 rounded-full bg-sun"
              style={{ left: `${(m / duration) * 100}%` }}
            />
          ))}
          <View
            className="absolute h-4 w-4 rounded-full bg-white"
            style={{ left: `${(p.pos / duration) * 100}%`, marginLeft: -4 }}
          />
        </Pressable>
        <View className="flex-row items-center justify-between px-1">
          <Text className="tabular-nums text-caption2 text-white/60">
            {mmss(p.pos)} / {mmss(duration)}
          </Text>
          <Pressable
            onPress={() => p.setRate(SPEEDS[(SPEEDS.indexOf(p.rate) + 1) % SPEEDS.length] ?? 1)}
            className="rounded-full bg-white/15 px-2 py-0.5"
          >
            <Text className="text-caption2 font-semibold text-white">{p.rate}x 배속</Text>
          </Pressable>
        </View>
        <View className="mt-2 flex-row items-center justify-center gap-3 pb-1">
          <Pressable
            accessibilityLabel="북마크 추가"
            onPress={addMark}
            className="h-10 w-10 items-center justify-center rounded-full bg-white"
          >
            <Bookmark size={ICON.sm} color={C.danger} />
          </Pressable>
          <Pressable
            accessibilityLabel="5초 뒤로"
            onPress={() => p.seek(p.pos - 5)}
            className="h-10 w-10 items-center justify-center rounded-full bg-white/10"
          >
            <Text className="text-caption2 font-bold text-white">◀5</Text>
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
            className="h-10 w-10 items-center justify-center rounded-full bg-white/10"
          >
            <Text className="text-caption2 font-bold text-white">5▶</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="구간 반복"
            onPress={() => p.setLoop(!p.loop)}
            className={cx(
              'h-10 w-10 items-center justify-center rounded-full',
              p.loop ? 'bg-sun' : 'bg-brand',
            )}
          >
            <Repeat size={ICON.sm} color={p.loop ? C.ink : '#fff'} />
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
              className="flex-row items-center gap-3 rounded-xl border border-line px-4 py-3"
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
