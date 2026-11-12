import { screen } from '@testing-library/react-native';
import { LoginScreen } from '../features/auth/auth';
import { renderScreen } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

it('로그인은 이메일 · 비밀번호 칸이 먼저, 그 아래 카카오 · Google · 네이버, 맨 아래 회원가입 순서다', async () => {
  await renderScreen(<LoginScreen />);
  // 시트를 열지 않아도 바로 입력할 수 있다
  expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy();
  expect(screen.getByPlaceholderText('8자 이상')).toBeTruthy();
  const tree = JSON.stringify(screen.toJSON());
  const order = [
    'you@example.com',
    '카카오로 시작하기',
    'Google로 시작하기',
    '네이버로 시작하기',
    '회원가입',
  ].map((t) => tree.indexOf(t));
  expect(order.every((at) => at >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // 간편 로그인은 글자 없이 로고 버튼 한 줄
  for (const l of ['카카오로 시작하기', 'Google로 시작하기', '네이버로 시작하기']) {
    expect(screen.getByRole('button', { name: l })).toBeTruthy();
    expect(screen.queryByText(l)).toBeNull();
  }
  expect(screen.getByText('또는 간편하게 시작')).toBeTruthy();
});
