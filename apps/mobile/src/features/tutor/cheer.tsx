import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeInRight, ReduceMotion } from 'react-native-reanimated';
import { Text } from '@/components/text';
import { cx } from '@/components/ui';
import { Avatar3D, type Mood } from './avatar3d';
import { useEquippedAvatar } from './buddy';

// 맞히면 칭찬, 틀리면 격려. 다음 학습(복습)으로 이어지는 말로
export const PRAISE = [
  '정답이에요! 노트 내용을 정확히 기억하고 있네요.',
  '잘했어요! 이 개념은 이제 확실히 익혔어요.',
  '맞았어요! 이 기세로 다음 문제도 가 봐요.',
];
export const ENCOURAGE = [
  '괜찮아요, 틀린 문제는 복습에서 다시 만나요.',
  '아쉬워요! 해설을 보면 금방 기억날 거예요.',
  '틀려도 괜찮아요. 이렇게 하나씩 익히는 거예요.',
];

/**
 * 퀴즈 · 복습 문제를 푼 뒤 아바타 선생님의 한마디. 문제마다 말이 바뀌고(같은 문제는 같은 말),
 * 말풍선은 오른쪽에서 들어온다. 잠깐 말하고 입을 닫는다.
 */
export function AvatarCheer({ right, index }: { right: boolean; index: number }) {
  const avatar = useEquippedAvatar();
  // 이 문제의 한마디를 말한 뒤에만 입을 닫는다(문제가 바뀌면 다시 말함)
  const key = `${index}-${right}`;
  const [quiet, setQuiet] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQuiet(key), 1600);
    return () => clearTimeout(t);
  }, [key]);
  const mood: Mood = quiet === key ? 'idle' : 'talking';
  const words = (right ? PRAISE : ENCOURAGE)[index % 3]!;
  return (
    <Animated.View
      entering={FadeInRight.springify()
        .duration(420)
        .dampingRatio(0.7)
        .reduceMotion(ReduceMotion.System)}
      className="mt-4 flex-row items-center gap-2"
    >
      <View className="h-14 w-14 items-center justify-center overflow-hidden rounded-full bg-mint">
        <Avatar3D mood={mood} avatarId={avatar} size={52} framing="head" />
      </View>
      <View
        className={cx(
          'flex-1 rounded-2xl rounded-bl-sm px-3.5 py-2.5',
          right ? 'bg-correct-soft' : 'bg-white',
        )}
      >
        <Text className="text-footnote text-ink">{words}</Text>
      </View>
    </Animated.View>
  );
}
