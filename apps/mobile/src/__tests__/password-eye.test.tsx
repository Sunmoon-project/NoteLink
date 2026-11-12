import { fireEvent, render, screen } from '@testing-library/react-native';
import { Input } from '../components/ui';

it('비밀번호 칸은 처음에 가리고, 눈 단추로 보기 · 가리기를 바꾼다', async () => {
  await render(<Input placeholder="8자 이상" value="secret12" secureTextEntry />);
  const field = () => screen.getByPlaceholderText('8자 이상');
  expect(field().props.secureTextEntry).toBe(true);
  await fireEvent.press(screen.getByLabelText('비밀번호 보기'));
  expect(field().props.secureTextEntry).toBe(false);
  await fireEvent.press(screen.getByLabelText('비밀번호 숨기기'));
  expect(field().props.secureTextEntry).toBe(true);
});

it('비밀번호가 아닌 칸에는 눈 단추가 없다', async () => {
  await render(<Input placeholder="you@example.com" value="" />);
  expect(screen.queryByLabelText('비밀번호 보기')).toBeNull();
  expect(screen.getByPlaceholderText('you@example.com').props.secureTextEntry).toBe(false);
});
