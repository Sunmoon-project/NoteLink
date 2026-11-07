import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { TextInput } from '../components/text';

const spacing = (placeholder: string) =>
  StyleSheet.flatten(screen.getByPlaceholderText(placeholder).props.style).letterSpacing;

it('간격을 따로 주지 않은 입력칸은 글자 간격이 0으로 고정되고, tracking-을 준 칸은 덮어쓰지 않는다', async () => {
  await render(
    <>
      <TextInput placeholder="이름" />
      <TextInput placeholder="코드" className="tracking-[6px]" />
    </>,
  );
  // iOS가 재사용한 입력칸에 앞 칸의 간격이 남지 않게 (스터디룸 코드 입력 → 만들기)
  expect(spacing('이름')).toBe(0);
  expect(spacing('코드')).not.toBe(0);
});
