import { waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import { PhotoGenScreen } from '../features/profile/avatar';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-file-system', () => ({ UploadType: { BINARY_CONTENT: 0 }, File: jest.fn() }));

// PR #38 리뷰: 완료 이벤트를 놓쳐도 로딩에서 빠져나온다
describe('프로필 이미지 생성', () => {
  it('끊긴 사이 작업이 끝났으면 상태 재조회로 한 번만 빠져나온다', async () => {
    const dismissTo = jest.fn();
    Object.assign(router, { dismissTo });
    jest.spyOn(api.ai, 'job').mockResolvedValue({ _id: 'j1', status: 'succeeded' } as never);
    setParams({ jobId: 'j1' });
    await renderScreen(<PhotoGenScreen />);
    await waitFor(() => expect(dismissTo).toHaveBeenCalledWith('/(tabs)/profile'));
    expect(dismissTo).toHaveBeenCalledTimes(1);
  });

  it('진행 중이면 그대로 기다린다', async () => {
    const dismissTo = jest.fn();
    Object.assign(router, { dismissTo });
    const job = jest
      .spyOn(api.ai, 'job')
      .mockResolvedValue({ _id: 'j2', status: 'running' } as never);
    setParams({ jobId: 'j2' });
    await renderScreen(<PhotoGenScreen />);
    await waitFor(() => expect(job).toHaveBeenCalled());
    expect(dismissTo).not.toHaveBeenCalled();
  });
});
