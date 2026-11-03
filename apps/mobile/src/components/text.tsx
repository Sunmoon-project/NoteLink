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

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput(
  { style, ...props },
  ref,
) {
  return (
    <RNTextInput ref={ref} maxFontSizeMultiplier={MAX_SCALE} {...props} style={[base, style]} />
  );
});
