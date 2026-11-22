// SOC-002: 친구 상태가 바뀌어도 친구 창에 늦게 보였다(친구 목록 30초 캐시).
// 친구 창을 열 때마다 친구 목록을 새로 읽는다. 상태 변경 소켓 신호(서버)는 범위 밖
import { screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { SocialDrawer } from '../features/social/drawer';
import { api } from '../lib/api';
import { renderScreen } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
afterEach(() => jest.restoreAllMocks());

it('30초 캐시가 남아 있어도 친구 창을 다시 열면 친구 목록을 새로 읽는다', async () => {
  const [friend] = await api.social.friends();
  expect(friend).toBeTruthy();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  // 조금 전 친구 창에서 읽어 둔 목록: 그때는 오프라인
  qc.setQueryData(['friends'], [{ ...friend!, status: 'offline' }]);
  // 지금 서버에서는 쉬는 중(내 상태는 시드대로 활동 중이라 글자가 겹치지 않는 두 상태로 본다)
  const friends = jest
    .spyOn(api.social, 'friends')
    .mockResolvedValue([{ ...friend!, status: 'resting' }]);
  await renderScreen(<SocialDrawer open onClose={() => {}} />, qc);
  await waitFor(() => expect(friends).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('쉬는 중')).toBeTruthy();
  expect(screen.queryByText('오프라인')).toBeNull();
  qc.clear();
});
