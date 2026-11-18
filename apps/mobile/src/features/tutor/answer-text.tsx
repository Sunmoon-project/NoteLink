import { View } from 'react-native';
import { Text } from '@/components/text';
import { cx } from '@/components/ui';

/** 답변 한 덩어리: 문단 · 번호 목록 항목 · 글머리표 항목 */
export type AnswerBlock =
  | { kind: 'p'; text: string }
  | { kind: 'ol'; no: string; text: string }
  | { kind: 'ul'; text: string };

const OL = /^(\d{1,2})[.)]\s+/;
const UL = /^[-•*·]\s+/;
/** 예전 답변(한 문단)에서 나열을 알아보는 말머리: 1번, · 첫째, · 둘째, … · 그 밖에 */
const LEAD =
  /(?=(?:\d{1,2}번[,.]?\s|첫째[,.]?\s|둘째[,.]?\s|셋째[,.]?\s|넷째[,.]?\s|다섯째[,.]?\s|그 밖에\s))/g;
/** 한 문단으로 보여 주는 길이 상한. 넘으면 문장 두 개씩 끊는다(예전 답변 · 지침을 따르지 않은 답변) */
const LONG = 140;

/**
 * 선생님 답변을 읽기 좋은 덩어리로 나눈다.
 * - 빈 줄 · 줄바꿈으로 문단을 나누고, '1. ' · '- '로 시작하는 줄은 목록 항목으로
 * - 줄바꿈 없이 길게 온 답은 「1번 · 첫째」 같은 나열 말머리에서 나누고, 그래도 길면 문장 두 개씩 문단으로
 */
export function formatAnswer(text: string): AnswerBlock[] {
  const lines = text
    .replace(/\r/g, '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const blocks: AnswerBlock[] = [];
  for (const line of lines) {
    const ol = OL.exec(line);
    if (ol) blocks.push({ kind: 'ol', no: ol[1]!, text: line.slice(ol[0].length) });
    else if (UL.test(line)) blocks.push({ kind: 'ul', text: line.replace(UL, '') });
    else if (line.length > LONG) blocks.push(...splitLong(line));
    else blocks.push({ kind: 'p', text: line });
  }
  return blocks;
}

function splitLong(line: string): AnswerBlock[] {
  const parts = line
    .split(LEAD)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > 2)
    return parts.map((p) => {
      const m = /^(\d{1,2})번[,.]?\s+/.exec(p);
      return m
        ? { kind: 'ol' as const, no: m[1]!, text: p.slice(m[0].length) }
        : { kind: 'p' as const, text: p };
    });
  // 문장 끝(. ? !) 뒤에서 나눠 두 문장씩 묶는다
  const sentences = line.split(/(?<=[.?!])\s+/).filter(Boolean);
  const out: AnswerBlock[] = [];
  for (let i = 0; i < sentences.length; i += 2)
    out.push({ kind: 'p', text: sentences.slice(i, i + 2).join(' ') });
  return out;
}

/** **굵게**만 살린다. 닫히지 않은 **(글자가 차례로 나오는 중)는 기호만 지운다 */
function Inline({ text, tone }: { text: string; tone: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return (
    <Text className={cx('text-footnote leading-5', tone)}>
      {parts.map((p, i) =>
        /^\*\*[^*]+\*\*$/.test(p) ? (
          <Text key={i} className="font-bold text-ink">
            {p.slice(2, -2)}
          </Text>
        ) : (
          p.replace(/\*\*/g, '').replace(/`/g, '')
        ),
      )}
    </Text>
  );
}

/** 선생님 답변: 문단은 간격을 두고, 목록은 번호 · 점을 앞에 붙여 들여 쓴다 */
export function AnswerText({ text, muted }: { text: string; muted?: boolean }) {
  const tone = muted ? 'text-sub' : 'text-ink';
  return (
    <View className="gap-2" accessibilityLabel={text.replace(/\*\*/g, '')}>
      {formatAnswer(text).map((b, i) =>
        b.kind === 'p' ? (
          <Inline key={i} text={b.text} tone={tone} />
        ) : (
          <View key={i} className="flex-row gap-1.5 pr-1">
            <Text
              className={cx(
                'text-footnote leading-5 font-semibold',
                muted ? 'text-sub' : 'text-brand',
              )}
            >
              {b.kind === 'ol' ? `${b.no}.` : '•'}
            </Text>
            <View className="flex-1">
              <Inline text={b.text} tone={tone} />
            </View>
          </View>
        ),
      )}
    </View>
  );
}
