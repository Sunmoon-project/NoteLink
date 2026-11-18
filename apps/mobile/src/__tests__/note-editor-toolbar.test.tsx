import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { Material } from '@notelink/shared';
import { EditScreen, applyFormat, summaryForSave } from '../features/content/detail';
import { NoteBody } from '../features/content/convert';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-file-system', () => ({ Directory: jest.fn(), File: jest.fn(), Paths: {} }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(), shareAsync: jest.fn() }));
jest.mock('../lib/image-edit', () => ({ editPhoto: jest.fn() }));
jest.mock('../lib/push', () => ({ notifyLocal: jest.fn() }));
jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

afterEach(() => jest.restoreAllMocks());

// 사용자 보고: 툴바(B · H1 · 목록 · 이미지 · 링크)를 눌러도 아무 일이 없었다
describe('툴바 서식', () => {
  it('굵게는 고른 글자를 **로 감싸고, 고른 게 없으면 자리에 굵은 글씨 틀을 넣는다', () => {
    expect(applyFormat('가나다라', { start: 1, end: 3 }, 'bold').text).toBe('가**나다**라');
    expect(applyFormat('가나', { start: 2, end: 2 }, 'bold').text).toBe('가나**굵게**');
  });
  it('제목 · 목록은 커서가 있는 줄 앞에 붙이고, 이미 있으면 뗀다', () => {
    const text = '첫 줄\n둘째 줄';
    expect(applyFormat(text, { start: 6, end: 6 }, 'heading').text).toBe('첫 줄\n# 둘째 줄');
    expect(applyFormat('# 제목', { start: 3, end: 3 }, 'heading').text).toBe('제목');
    expect(applyFormat(text, { start: 0, end: 0 }, 'list').text).toBe('- 첫 줄\n둘째 줄');
    expect(applyFormat('- 항목', { start: 3, end: 3 }, 'list').text).toBe('항목');
  });
  it('링크는 고른 글자를 [글자](https://)로 바꾼다', () => {
    expect(applyFormat('사이트 보기', { start: 0, end: 3 }, 'link').text).toBe(
      '[사이트](https://) 보기',
    );
  });
});

// 사용자 보고: 수정한 내용이 저장되지 않았다 — 제목 없이 본문만 쓴 섹션이 있으면 서버가 400(제목 1자 이상)으로 거절했다
it('제목을 비운 섹션은 서버 규칙(제목 1자 이상)에 맞게 「내용 N」 제목을 붙여 보낸다', () => {
  expect(
    summaryForSave([
      { heading: '정리', body: '본문' },
      { heading: '  ', body: '제목 없는 메모' },
      { heading: '', body: '' },
    ]),
  ).toEqual([
    { heading: '정리', body: '본문' },
    { heading: '내용 2', body: '제목 없는 메모' },
  ]);
});

const material = {
  _id: 'n1',
  folderId: 'f1',
  title: '노트',
  kind: 'handwriting',
  createdAt: '2026-11-18T00:00:00Z',
  summary: { sections: [{ heading: '정리', body: '본문' }], points: [] },
  processing: { status: 'done', progress: 100, jobId: null },
} as unknown as Material;

it('글을 고치는 중(키보드가 올라온 동안)에도 툴바와 취소 · 저장 버튼이 그대로 있고, 툴바가 본문을 바꾼다', async () => {
  jest.spyOn(api.content, 'material').mockResolvedValue(material);
  setParams({ id: 'n1' });
  await renderScreen(<EditScreen />);
  const body = await screen.findByLabelText('노트 내용');
  await fireEvent(body, 'focus');
  await fireEvent(body, 'selectionChange', { nativeEvent: { selection: { start: 0, end: 2 } } });
  expect(screen.getByText('취소')).toBeTruthy();
  // 이미지 넣기는 이번 범위 밖이라 버튼을 두지 않는다
  expect(screen.queryByLabelText('이미지')).toBeNull();
  await fireEvent.press(screen.getByLabelText('굵게'));
  expect(screen.getByLabelText('노트 내용').props.value).toBe('**본문**');
});

it('상세 화면은 # 제목 · - 목록 · **굵게** 표시대로 그린다(기호는 보이지 않는다)', async () => {
  await renderScreen(
    <NoteBody sections={[{ heading: '정리', body: '# 큰 제목\n- 항목\n**중요** 내용' }]} />,
  );
  expect(screen.getByText('큰 제목')).toBeTruthy();
  expect(screen.getByText('• 항목')).toBeTruthy();
  expect(screen.getByText('중요')).toBeTruthy();
  expect(screen.queryByText(/\*\*/)).toBeNull();
});
