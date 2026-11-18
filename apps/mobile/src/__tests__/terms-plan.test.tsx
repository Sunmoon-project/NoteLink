import { fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderScreen, setParams } from '../test-utils';
import { TermsScreen } from '../features/auth/auth';
import { canChangePlan } from '../features/profile/settings';
import { LegalDocScreen } from '../features/auth/legal';
import { LEGAL_DOCS } from '../features/auth/legal-docs';

jest.mock('../lib/env', () => ({ env: { localData: false, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

// PR #32 리뷰: '보기'는 전문만 열고 동의 상태는 바꾸지 않는다
describe('약관 동의', () => {
  it('보기를 누르면 앱 안 전문 화면을 열고 체크는 그대로 둔다', async () => {
    jest.mocked(router.push).mockClear();
    await renderScreen(<TermsScreen />);
    await fireEvent.press(screen.getByLabelText('이용약관 (필수) 전문 보기'));
    // 예전엔 우리 것이 아닌 외부 주소(notelink.app)를 열었다
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/legal/[doc]',
      params: { doc: 'service' },
    });
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes[0]?.props.accessibilityState).toMatchObject({ checked: false });
    await fireEvent.press(boxes[0]!);
    expect(screen.getAllByRole('checkbox')[0]?.props.accessibilityState).toMatchObject({
      checked: true,
    });
  });
});

describe('약관 전문 화면', () => {
  it.each(['service', 'privacy', 'marketing'] as const)(
    '%s 전문의 제목과 조항을 보여 준다',
    async (doc) => {
      setParams({ doc });
      await renderScreen(<LegalDocScreen />);
      expect(screen.getByText(LEGAL_DOCS[doc].title)).toBeTruthy();
      expect(screen.getByText(LEGAL_DOCS[doc].sections[0]!.heading)).toBeTruthy();
    },
  );

  it('알 수 없는 문서면 이용약관을 보여 준다', async () => {
    setParams({ doc: 'nope' });
    await renderScreen(<LegalDocScreen />);
    expect(screen.getByText(LEGAL_DOCS.service.title)).toBeTruthy();
  });
});

describe('요금제', () => {
  it('결제 연동 전 실서버에서는 무료 플랜으로만 바꾼다', () => {
    expect(canChangePlan('free')).toBe(true);
    expect(canChangePlan('pro')).toBe(false);
    expect(canChangePlan('max')).toBe(false);
  });
});

// Codex #490 리뷰: 문서가 안내한 철회 경로가 앱에 실제로 있어야 한다(없는 「설정에서 끄기」를 안내하던 문제)
describe('약관이 안내하는 경로', () => {
  const all = (doc: keyof typeof LEGAL_DOCS) =>
    LEGAL_DOCS[doc].sections.flatMap((s) => s.body).join('\n');

  it('마케팅 철회는 앱에 있는 「도움말 및 지원」으로 안내하고, 없는 설정 메뉴를 안내하지 않는다', () => {
    expect(all('marketing')).toContain('도움말 및 지원');
    expect(all('marketing')).not.toMatch(/설정에서 마케팅/);
  });

  it('아이디를 가입 이메일로 설명하지 않는다(아이디는 따로 정한다)', () => {
    expect(all('service')).not.toContain('회원의 아이디는 가입한 이메일입니다');
    expect(all('privacy')).not.toContain('이메일(아이디)');
  });
});
