import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/text';
import { cx, OnFill, Tap } from '@/components/ui';

const NUM = '①②③④⑤⑥⑦⑧⑨⑩';

/**
 * 서버(toAppQuestion)는 지문을 질문 아래 빈 줄 뒤에 붙여 보낸다. 질문과 지문을 나눠 지문은 작게 보여 준다
 * (객관식은 지문 자리에 개념 이름만 오는 일이 많아 질문과 겹쳐 보였다)
 */
export function splitPrompt(prompt: string): [string, string | null] {
  const at = prompt.indexOf('\n\n');
  return at < 0 ? [prompt, null] : [prompt.slice(0, at), prompt.slice(at + 2).trim() || null];
}

/**
 * 퀴즈 풀이 화면의 보기 한 칸. 번호(①②③)를 앞에 붙이고, 글은 자르지 않고 줄을 넘겨 다 보인다.
 * onPress가 없으면 보여 주기만 한다(보관함). fill은 놓일 면에 맞춘 바탕(흰 카드 안이면 bg-canvas)
 */
export function ChoiceRow({
  n,
  children,
  on = false,
  onPress,
  disabled,
  fill = 'bg-white',
}: {
  n: number;
  children: ReactNode;
  on?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  fill?: string;
}) {
  const body = (
    <>
      <OnFill on={on} fill="bg-mint" />
      <Text className="flex-1 text-subhead leading-6 text-ink">
        {NUM[n] ?? `${n + 1}.`} {children}
      </Text>
    </>
  );
  const cls = cx('min-h-14 flex-row items-center overflow-hidden rounded-2xl px-5 py-4', fill);
  return onPress ? (
    <Tap onPress={onPress} disabled={disabled} accessibilityRole="button" className={cls}>
      {body}
    </Tap>
  ) : (
    <View className={cls}>{body}</View>
  );
}
