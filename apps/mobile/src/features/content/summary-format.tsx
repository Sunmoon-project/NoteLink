import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Material, SummaryFormat } from '@notelink/shared';
import { Btn, Sheet } from '@/components/ui';

// 노트 정리 양식(FR-19). 위쪽 요약 칸의 모습만 바뀌고 본문은 그대로다
export const FORMATS: { value: SummaryFormat; name: string; hint: string }[] = [
  { value: 'points', name: '핵심 요약', hint: '꼭 알아야 할 내용을 문장으로' },
  { value: 'qa', name: '문답', hint: '스스로 확인할 질문과 짧은 답' },
  { value: 'terms', name: '용어 정리', hint: '노트에 나온 용어와 뜻' },
  { value: 'brief', name: '한눈 요약', hint: '전체를 세 줄로' },
];
export const formatName = (f: SummaryFormat) => FORMATS.find((x) => x.value === f)!.name;

/**
 * 양식 고르기 시트. current 를 주면(다시 만들기) 그 양식은 「지금 양식」으로 보이고 고를 수 없다.
 * 닫으면 onClose — 처음 만들 때는 부르는 쪽이 기본 양식으로 진행한다
 */
export function FormatSheet({
  open,
  current,
  onPick,
  onClose,
  note,
}: {
  open: boolean;
  current?: SummaryFormat;
  onPick: (f: SummaryFormat) => void;
  onClose: () => void;
  note?: string;
}) {
  // 처음 만들 때는 기본(핵심 요약)을 골라 두고, 다시 만들기는 직접 고르게 비워 둔다
  const first: SummaryFormat | null = current ? null : 'points';
  const [picked, setPicked] = useState<SummaryFormat | null>(first);
  // 열 때마다 처음 고른 값으로 되돌린다(렌더 중 비교 — 효과에서 상태를 바꾸지 않게)
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setPicked(first);
  }
  return (
    <Sheet open={open} onClose={onClose} title="어떤 모습으로 정리할까요?">
      <View className="gap-2">
        {FORMATS.map((f) => {
          const now = f.value === current;
          const on = !now && f.value === picked;
          return (
            <Pressable
              key={f.value}
              accessibilityRole="radio"
              accessibilityLabel={f.name}
              accessibilityState={{ checked: on, disabled: now }}
              disabled={now}
              onPress={() => setPicked(f.value)}
              className={`flex-row items-center gap-3 rounded-2xl border px-4 py-3 ${
                on ? 'border-brand bg-mint' : 'border-line bg-surface'
              } ${now ? 'opacity-50' : ''}`}
            >
              <View
                className={`h-5 w-5 items-center justify-center rounded-full border-2 ${
                  on ? 'border-brand' : 'border-line'
                }`}
              >
                {on && <View className="h-2.5 w-2.5 rounded-full bg-brand" />}
              </View>
              <View className="flex-1">
                <Text className="text-body font-semibold text-ink">
                  {f.name}
                  {now ? ' · 지금 양식' : ''}
                </Text>
                <Text className="text-footnote text-sub">{f.hint}</Text>
              </View>
            </Pressable>
          );
        })}
        {note && <Text className="px-1 text-caption text-sub">{note}</Text>}
        <Btn className="mt-2" disabled={!picked} onPress={() => picked && onPick(picked)}>
          이 모습으로 만들기
        </Btn>
      </View>
    </Sheet>
  );
}

type Summary = NonNullable<Material['summary']>;

/** 위쪽 요약 칸. items 가 없으면(옛 노트 · 문서 조각 제목) points 를 핵심 요약으로 그린다 */
export function SummaryCard({ summary }: { summary: Summary | null | undefined }) {
  if (!summary) return null;
  const format = summary.items?.length ? (summary.format ?? 'points') : 'points';
  const items = summary.items?.length
    ? summary.items
    : summary.points.map((text) => ({ head: null, text }));
  if (items.length === 0) return null;
  return (
    <View className="mb-3 rounded-3xl bg-surface px-5 py-4">
      <Text className="mb-2 text-callout font-bold text-ink">{formatName(format)}</Text>
      {format === 'qa' ? (
        <View className="gap-3">
          {items.map((i, n) => (
            <View key={n}>
              <Text className="text-body font-bold text-ink">Q. {i.head}</Text>
              <Text className="mt-0.5 text-body text-sub">{i.text}</Text>
            </View>
          ))}
        </View>
      ) : format === 'terms' ? (
        <View className="gap-2.5">
          {items.map((i, n) => (
            <View key={n} className="flex-row items-start gap-2">
              <View className="rounded-full bg-mint px-2.5 py-0.5">
                <Text className="text-footnote font-semibold text-brand">{i.head}</Text>
              </View>
              <Text className="flex-1 text-body text-sub">{i.text}</Text>
            </View>
          ))}
        </View>
      ) : (
        <View className="gap-1.5">
          {items.map((i, n) => (
            <Text key={n} className="text-body text-sub">
              • {i.text}
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

/** 마크다운 내보내기의 요약 부분(양식대로). 없으면 빈 글 */
export function summaryItemsMarkdown(summary: Summary | null | undefined): string {
  if (!summary) return '';
  const format = summary.items?.length ? (summary.format ?? 'points') : 'points';
  const items = summary.items?.length
    ? summary.items
    : summary.points.map((text) => ({ head: null, text }));
  if (items.length === 0) return '';
  const lines = items.map((i) =>
    format === 'qa'
      ? `- **Q. ${i.head}**\n  ${i.text}`
      : format === 'terms'
        ? `- **${i.head}**: ${i.text}`
        : `- ${i.text}`,
  );
  return `## ${formatName(format)}\n\n${lines.join('\n')}\n`;
}
