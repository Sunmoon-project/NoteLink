import { X } from 'lucide-react-native';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Text } from '@/components/text';
import { cx, OnFill, Tap } from '@/components/ui';
import { C, ICON } from '@/theme';

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
 * 질문 뒤 지문. 객관식에서 한 줄짜리 짧은 지문은 대개 개념 이름이라(질문과 겹쳐 보임) 작고 흐리게,
 * 그 밖의 지문(ㄱ·ㄴ·ㄷ 보기 · 빈칸 문제 · 정의문)은 풀이에 필요하므로 질문과 같은 크기로 보여 준다
 */
export function Passage({
  prompt,
  mc,
  className,
}: {
  prompt: string;
  mc: boolean;
  className?: string;
}) {
  const text = splitPrompt(prompt)[1];
  if (!text) return null;
  const concept = mc && !text.includes('\n') && text.length <= 40;
  return (
    <Text
      className={cx(
        'mt-2',
        concept ? 'text-footnote leading-5 text-sub' : 'text-subhead leading-6 text-ink',
        className,
      )}
    >
      {text}
    </Text>
  );
}

/**
 * 퀴즈 풀이 화면의 보기 한 칸. 번호(①②③)를 앞에 붙이고, 글은 자르지 않고 줄을 넘겨 다 보인다.
 * onPress가 없으면 보여 주기만 한다(보관함). fill은 놓일 면에 맞춘 바탕(흰 카드 안이면 bg-canvas)
 */
export function ChoiceRow({
  n,
  children,
  on = false,
  wrong = false,
  onPress,
  disabled,
  fill = 'bg-white',
}: {
  n: number;
  children: ReactNode;
  on?: boolean;
  /** 결과 화면: 내가 고른 오답 보기. 빨간 테두리와 X 표시 */
  wrong?: boolean;
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
      {wrong && (
        <View accessibilityLabel="내가 고른 오답" className="ml-2">
          <X size={ICON.sm} color={C.danger} />
        </View>
      )}
    </>
  );
  const cls = cx(
    'min-h-14 flex-row items-center overflow-hidden rounded-2xl px-5 py-4',
    fill,
    wrong && 'border-2 border-danger',
  );
  return onPress ? (
    <Tap onPress={onPress} disabled={disabled} accessibilityRole="button" className={cls}>
      {body}
    </Tap>
  ) : (
    <View className={cls}>{body}</View>
  );
}
