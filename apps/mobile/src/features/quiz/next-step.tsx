import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated from 'react-native-reanimated';
import { CalendarCheck, type LucideIcon } from 'lucide-react-native';
import { Text } from '@/components/text';
import { FADE_IN, Row } from '@/components/ui';
import { daysBetween, md, parse, today } from '@/lib/dates';
import { Avatar3D } from '@/features/tutor/avatar3d';
import { useEquippedAccessories, useEquippedAvatar, useFocused } from '@/features/tutor/buddy';
import { C, ICON } from '@/theme';

export type NextStep = { label: string; sub?: string; icon: LucideIcon; onPress: () => void };

/** 서버 복습 날짜('YYYY-MM-DD', 서울) → 문장에 넣는 때: 내일이면 「내일」, 아니면 「11월 23일에」 */
export const reviewDayWord = (day: string) => {
  const d = parse(day);
  return daysBetween(today(), day) === 1 ? '내일' : `${d.getMonth() + 1}월 ${d.getDate()}일에`;
};

/** 한마디를 말하는 동안만 입을 움직인다(글이 길수록 조금 더). 말이 바뀌면 다시 말한다 */
export const talkMs = (line: string) => Math.min(4000, 1200 + line.length * 40);

/** 장착한 3D 아바타 선생님이 복습 흐름을 말풍선으로 알려 준다(퀴즈 풀이 중 AvatarCheer와 같은 얼굴) */
function TutorLine({ line }: { line: string }) {
  const avatar = useEquippedAvatar();
  const acc = useEquippedAccessories();
  // 비슷한 문제 · 해설 화면을 위에 띄우면 결과 화면은 남아 있으므로, 안 보이는 동안 3D를 그리지 않는다(TutorBuddy와 같다)
  const focused = useFocused();
  const [quiet, setQuiet] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQuiet(line), talkMs(line));
    return () => clearTimeout(t);
  }, [line]);
  return (
    <View className="flex-row items-start gap-3 px-5 pt-4">
      <View
        accessibilityLabel="아바타 선생님"
        className="h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-mint"
      >
        {focused && (
          <Avatar3D
            mood={quiet === line ? 'idle' : 'talking'}
            avatarId={avatar}
            accessories={acc}
            size={52}
            framing="head"
          />
        )}
      </View>
      <View className="flex-1 rounded-2xl rounded-tl-sm bg-mint px-3.5 py-2.5">
        <Text className="text-footnote leading-5 text-ink">{line}</Text>
      </View>
    </View>
  );
}

/** 퀴즈 결과 · 복습을 마친 화면의 「다음 단계」 카드(FR-37). 튜터 한마디 · 복습 일정 · 할 일 줄. 들어올 때 한 번 페이드 */
export function NextStepCard({
  line,
  reviewDay,
  steps,
}: {
  /** 3D 아바타 선생님의 한마디(줄바꿈으로 여러 줄) */
  line?: string;
  /** 서버가 복습 일정에 넣은 날짜. 있을 때만 「복습 일정에 넣었어요」를 보인다 */
  reviewDay?: string | null;
  steps: NextStep[];
}) {
  return (
    <Animated.View entering={FADE_IN} className="overflow-hidden rounded-card bg-white">
      {!!line && <TutorLine line={line} />}
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
