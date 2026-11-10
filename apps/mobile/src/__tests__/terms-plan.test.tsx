import { Linking } from 'react-native';
import { fireEvent, screen } from '@testing-library/react-native';
import { renderScreen } from '../test-utils';
import { TermsScreen } from '../features/auth/auth';
import { canChangePlan } from '../features/profile/settings';

jest.mock('../lib/env', () => ({ env: { localData: false, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

// PR #32 리뷰: '보기'는 전문만 열고 동의 상태는 바꾸지 않는다
describe('약관 동의', () => {
  it('보기를 누르면 전문을 열고 체크는 그대로 둔다', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await renderScreen(<TermsScreen />);
    await fireEvent.press(screen.getByLabelText('이용약관 (필수) 전문 보기'));
    expect(open).toHaveBeenCalledWith('https://notelink.app/terms');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0]?.props.accessibilityState).toMatchObject({ checked: false });
    await fireEvent.press(boxes[0]!);
    expect(screen.getAllByRole('checkbox')[0]?.props.accessibilityState).toMatchObject({
      checked: true,
    });
  });
});

describe('요금제', () => {
  it('결제 연동 전 실서버에서는 무료 플랜으로만 바꾼다', () => {
    expect(canChangePlan('free')).toBe(true);
    expect(canChangePlan('pro')).toBe(false);
    expect(canChangePlan('max')).toBe(false);
  });
});
