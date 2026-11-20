import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { CalendarCheck, GraduationCap, type LucideIcon } from 'lucide-react-native';
import { Text } from '@/components/text';
import { FADE_IN, Row } from '@/components/ui';
import { daysBetween, md, parse, today } from '@/lib/dates';
import { C, ICON } from '@/theme';

export type NextStep = { label: string; sub?: string; icon: LucideIcon; onPress: () => void };

/** 서버 복습 날짜('YYYY-MM-DD', 서울) → 문장에 넣는 때: 내일이면 「내일」, 아니면 「11월 23일에」 */
export const reviewDayWord = (day: string) => {
  const d = parse(day);
  return daysBetween(today(), day) === 1 ? '내일' : `${d.getMonth() + 1}월 ${d.getDate()}일에`;
};

/** 퀴즈 결과 · 복습을 마친 화면의 「다음 단계」 카드(FR-37). 튜터 한마디 · 복습 일정 · 할 일 줄. 들어올 때 한 번 페이드 */
export function NextStepCard({
  line,
  reviewDay,
  steps,
}: {
  /** 튜터 한마디(정지 얼굴 옆 한 줄) */
  line?: string;
  /** 서버가 복습 일정에 넣은 날짜. 있을 때만 「복습 일정에 넣었어요」를 보인다 */
  reviewDay?: string | null;
  steps: NextStep[];
}) {
  return (
    <Animated.View entering={FADE_IN} className="overflow-hidden rounded-card bg-white">
      {!!line && (
        <View className="flex-row items-center gap-3 px-5 pt-4">
          <View
            accessibilityLabel="AI 튜터"
            className="h-9 w-9 items-center justify-center rounded-full bg-mint"
          >
            <GraduationCap size={ICON.sm} color={C.brand} strokeWidth={1.8} />
          </View>
          <Text className="flex-1 text-footnote font-semibold text-ink">{line}</Text>
        </View>
      )}
      {!!reviewDay && (
        <View className="mx-5 mt-3 flex-row items-center gap-2 rounded-xl bg-mint px-3 py-2.5">
          <CalendarCheck size={ICON.xs} color={C.brand} />
          <Text className="flex-1 text-caption text-brand">
            복습 일정에 넣었어요 · 다음 복습 {md(reviewDay)}
          </Text>
        </View>
      )}
      <Text className="px-5 pt-4 text-caption font-semibold text-sub">다음 단계</Text>
      {steps.map((s, i) => (
        <View key={s.label} className={i ? 'border-t border-fill' : ''}>
          <Row icon={s.icon} sub={s.sub} onPress={s.onPress} chevron>
            {s.label}
          </Row>
        </View>
      ))}
    </Animated.View>
  );
}
