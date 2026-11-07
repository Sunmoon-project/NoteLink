import { forwardRef } from 'react';
import {
  StyleSheet,
  Text as RNText,
  TextInput as RNTextInput,
  type TextInputProps,
  type TextProps,
} from 'react-native';
import { FONT } from '@/theme';

// 앱의 모든 글자는 이 Text · TextInput을 쓴다 — 글꼴(Pretendard)을 한곳에서 정한다.
// 굵기는 className(font-medium · font-semibold · font-bold)의 fontWeight로 고른다.
// 시스템 글자 크기는 따르되, 레이아웃이 깨지지 않게 1.4배까지만 키운다.
const base = StyleSheet.create({ font: { fontFamily: FONT } }).font;
const MAX_SCALE = 1.4;

export const Text = forwardRef<RNText, TextProps>(function Text({ style, ...props }, ref) {
  return <RNText ref={ref} maxFontSizeMultiplier={MAX_SCALE} {...props} style={[base, style]} />;
});

// 간격을 따로 주지 않은 입력칸은 글자 간격을 0으로 못 박는다. iOS는 네이티브 입력칸을 재사용하는데,
// 간격을 준 칸(스터디룸 코드 입력 tracking-[6px])을 닫은 뒤 다른 입력칸이 그 간격을 물려받아
// 안내 문구가 벌어졌다. className의 tracking-이 있으면 그 값을 쓴다(이 기본값이 className보다 앞선다)
const inputBase = StyleSheet.create({ input: { fontFamily: FONT, letterSpacing: 0 } }).input;

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput(
  { style, ...props },
  ref,
) {
  return (
    <RNTextInput
      ref={ref}
      maxFontSizeMultiplier={MAX_SCALE}
      {...props}
      style={[props.className?.includes('tracking-') ? base : inputBase, style]}
    />
  );
});
