import { useCallback, useState } from 'react';
import { StyleSheet, View, type TextLayoutLine } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LayoutAnimationConfig,
  LinearTransition,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { Text } from '@/components/text';
import { filled, lineAt, type Line } from './captions';

// 녹음 자막(FR-20): 지금 문장 하나를 읽는 속도대로 회색 → 흰색으로 채우고, 아래에 다음 문장을 두 줄까지 흐리게 미리 보인다.
// 다 읽으면 지금 문장은 위로 빠지고 다음 문장이 제자리로 올라온다

const EASE = Easing.bezier(0.23, 1, 0.32, 1);
const T = { duration: 200, easing: EASE };
const MOVE = LinearTransition.duration(200).easing(EASE);
const ENTER = FadeIn.duration(200).easing(EASE);
// 동작 줄이기: 이동은 빼고 투명도 교차만(시스템 설정에 꺼지지 않게 Never)
const FADE_IN = FadeIn.duration(150).reduceMotion(ReduceMotion.Never);
const FADE_OUT = FadeOut.duration(150).reduceMotion(ReduceMotion.Never);
/** 다 읽은 문장: 위로 12px 밀리며 사라짐 */
const EXIT_UP = () => {
  'worklet';
  return {
    initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
    animations: {
      opacity: withTiming(0, T),
      transform: [{ translateY: withTiming(-12, T) }],
    },
  };
};

type Shown = { lines: readonly Line[]; from: number; i: number; epoch: number };

/**
 * lines는 지금 슬라이드 구간의 문장들(비어 있지 않음), then은 다음 구간의 첫 문장(구간 끝에서 미리보기로). pos는 0.25초마다 오는 재생 위치(되감기 · 북마크 이동을
 * 바로 따른다), clock은 프레임마다 이어 붙인 위치(채움 · 문장 넘김을 소리에 맞춘다)
 */
export function Captions({
  lines,
  clock,
  pos,
  then,
}: {
  lines: readonly Line[];
  clock: SharedValue<number>;
  pos: number;
  then?: Line;
}) {
  const reduce = useReducedMotion();
  const from = lineAt(lines, pos);
  const [shown, setShown] = useState<Shown>({ lines, from, i: from, epoch: 0 });
  let s = shown;
  // 재생 위치(상태)가 다른 문장으로 옮겨 가거나 구간이 바뀌면 따른다(렌더 중 상태 조정)
  if (shown.lines !== lines || shown.from !== from) {
    s = { lines, from, i: from, epoch: shown.epoch + (jump(shown, lines, from) ? 1 : 0) };
    setShown(s);
  }
  // 프레임 시계가 문장 끝을 넘는 순간 넘긴다(상태를 기다리면 최대 0.25초 늦음). 문장이 바뀔 때만 React로.
  // 앞으로만: 뒤로 가는 건 되감기뿐이고 그건 재생 위치(pos)가 맡는다(시계가 살짝 흔들려 앞 문장으로 튀지 않게)
  const advance = useCallback(
    (i: number) =>
      setShown((c) =>
        c.lines === lines && i > c.i
          ? { ...c, i, epoch: c.epoch + (jump(c, lines, i) ? 1 : 0) }
          : c,
      ),
    [lines],
  );
  useAnimatedReaction(
    () => lineAt(lines, clock.get()),
    (i, prev) => {
      if (prev !== null && i !== prev) scheduleOnRN(advance, i);
    },
    [lines, advance],
  );

  // 구간의 마지막 문장이면 다음 구간 첫 문장을 미리 보인다(긴 문장 뒤에 미리보기가 비지 않게)
  const rows = [lines[s.i], lines[s.i + 1] ?? (s.i === lines.length - 1 ? then : undefined)];
  return (
    // 두 문장 넘게 건너뛰면(되감기 · 북마크) 넘김 없이 바로 바꾼다
    <LayoutAnimationConfig key={s.epoch} skipEntering skipExiting>
      <View testID="captions" style={BOX}>
        {rows.map(
          (line, k) =>
            line && (
              <Animated.View
                key={line.startSec}
                testID={`caption-row-${k}`}
                layout={reduce ? undefined : MOVE}
                entering={reduce ? FADE_IN : ENTER}
                exiting={reduce ? FADE_OUT : EXIT_UP}
              >
                {k === 0 ? (
                  <NowLine line={line} clock={clock} />
                ) : (
                  <Text
                    testID="caption-next"
                    numberOfLines={2}
                    accessibilityLabel={`다음 문장, ${line.text}`}
                    className="mt-2 text-footnote leading-5 text-white/45"
                  >
                    {line.text}
                  </Text>
                )}
              </Animated.View>
            ),
        )}
      </View>
    </LayoutAnimationConfig>
  );
}

/**
 * 바로 다음 문장으로 넘어가는 것 말고는(되감기 · 건너뛰기 · 구간 바뀜) 넘김 애니메이션 없이. 이미 보이는 문장이면
 * (시계가 먼저 넘긴 뒤 재생 상태가 따라옴) 넘김이 아니다 — 묶음을 다시 붙이면 진행 중인 넘김이 끊긴다
 */
const jump = (c: Shown, lines: readonly Line[], i: number) =>
  c.lines !== lines || (i !== c.i && i !== c.i + 1);

// 어두운 상자에서 4줄을 읽기 쉽게: 굵기 medium, 줄 간격 28, 안 읽은 글도 60% 밝기
const NOW = 'text-callout font-medium leading-7';
/** 짧은 문장에도 상자가 줄지 않게 지금 문장 4줄(28 × 4) 높이를 둔다(바뀌기 전 대본 상자 길이) */
const BOX = { minHeight: 112 };

/**
 * 지금 문장. 여러 줄 글은 한 덩어리로 칠할 수 없어 줄마다 흰 글을 겹쳐 놓고, 겹친 줄을 transform 두 겹으로
 * 가린다(바깥은 왼쪽으로, 안쪽 글은 오른쪽으로 같은 만큼 → 글은 제자리, 보이는 폭만 늘어남). 레이아웃 계산 없음
 */
function NowLine({ line, clock }: { line: Line; clock: SharedValue<number> }) {
  const [rows, setRows] = useState<TextLayoutLine[]>([]);
  const starts: number[] = [];
  let at = 0;
  for (const r of rows) {
    starts.push(at);
    at += r.text.length;
  }
  const total = at || line.text.length;
  return (
    <View>
      <Text
        testID="caption-now"
        onTextLayout={(e) => setRows(e.nativeEvent.lines)}
        className={`${NOW} text-white/60`}
      >
        {line.text}
      </Text>
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={StyleSheet.absoluteFill}
      >
        {rows.map((row, k) => (
          <FillRow key={k} row={row} start={starts[k]!} total={total} line={line} clock={clock} />
        ))}
      </View>
    </View>
  );
}

function FillRow({
  row,
  start,
  total,
  line,
  clock,
}: {
  row: TextLayoutLine;
  start: number;
  total: number;
  line: Line;
  clock: SharedValue<number>;
}) {
  // 이 줄에서 가려 둘 폭(px). 채운 글자 수 − 줄 시작 글자 → 줄 안 비율
  const hidden = useDerivedValue(() => {
    const f = (filled(line, clock.get()) * total - start) / (row.text.length || 1);
    return (1 - Math.min(1, Math.max(0, f))) * row.width;
  });
  const mask = useAnimatedStyle(() => ({ transform: [{ translateX: -hidden.get() }] }));
  const text = useAnimatedStyle(() => ({ transform: [{ translateX: hidden.get() }] }));
  return (
    <Animated.View
      style={[
        { position: 'absolute', left: row.x, top: row.y, width: row.width, height: row.height },
        { overflow: 'hidden' },
        mask,
      ]}
    >
      <Animated.View style={text}>
        <Text numberOfLines={1} className={`${NOW} text-white`} style={{ width: row.width + 4 }}>
          {row.text}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}
