import { render, screen } from '@testing-library/react-native';
import { AiPending } from '../components/AiPending';
import { withTopic } from '../lib/ai';

it.each([
  ['필기 정리', '필기 정리는'],
  ['문서 요약', '문서 요약은'],
  ['캠 · 음성', '캠 · 음성은'],
  ['친구 찾기', '친구 찾기는'],
  ['AI', 'AI는'],
])('%s에 맞는 은/는을 붙인다', (word, expected) => {
  expect(withTopic(word)).toBe(expected);
});

it('AI 대기 안내에 은(는)을 그대로 쓰지 않는다', async () => {
  await render(<AiPending what="필기 정리" />);
  expect(screen.getByText('필기 정리는 AI 서버를 기다리고 있어요')).toBeTruthy();
});
