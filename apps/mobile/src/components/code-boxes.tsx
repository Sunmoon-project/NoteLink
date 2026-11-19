import { useRef, useState } from 'react';
import { View, type TextInput as RNTextInput } from 'react-native';
import { Pressable } from '@/components/press';
import { Text, TextInput } from '@/components/text';
import { cx } from '@/components/ui';

const CODE_LEN = 6;

/** 인증번호 6칸. 보이지 않는 입력 하나를 받아 칸마다 한 자리씩 보여 준다(문자 자동 채우기 지원) */
export function CodeBoxes({
  value,
  onChange,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
}) {
  const input = useRef<RNTextInput>(null);
  const [focused, setFocused] = useState(true);
  return (
    <Pressable
      accessibilityLabel="인증번호 입력"
      onPress={() => input.current?.focus()}
      className="mt-6 flex-row justify-between"
    >
      {Array.from({ length: CODE_LEN }, (_, i) => {
        const on = focused && i === Math.min(value.length, CODE_LEN - 1);
        return (
          <View
            key={i}
            className={cx(
              'h-14 w-[14.5%] items-center justify-center rounded-xl border-2 bg-white',
              invalid ? 'border-danger' : on ? 'border-brand' : 'border-transparent',
            )}
          >
            <Text className="text-title2 font-bold tabular-nums text-ink">{value[i] ?? ''}</Text>
          </View>
        );
      })}
      <TextInput
        ref={input}
        value={value}
        onChangeText={(v) => onChange(v.replace(/\D/g, '').slice(0, CODE_LEN))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoFocus
        placeholder="메일로 받은 숫자 6자리"
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={CODE_LEN}
        // 칸 위에 겹쳐 두고 보이지 않게 한다(눌러서 포커스 · 붙여넣기는 그대로)
        className="absolute inset-0 text-transparent"
        style={{ opacity: 0.02 }}
        caretHidden
      />
    </Pressable>
  );
}
