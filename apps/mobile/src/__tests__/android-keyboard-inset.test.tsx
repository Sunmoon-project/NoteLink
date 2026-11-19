import { act, renderHook, screen } from '@testing-library/react-native';
import { Keyboard, Platform, StyleSheet, Text, View } from 'react-native';
import { Screen, Sheet } from '../components/ui';
import { keyboardOverlap, useKeyboardInset } from '../hooks/keyboard-inset';
import { renderScreen } from '../test-utils';

// 실기기(안드로이드) 보고: 키보드를 올리면 1:1 채팅 입력줄이 키보드 뒤로 완전히 숨었다(#567).
// edge-to-edge라 adjustResize가 창을 줄이지 않고, 공용 Screen · Sheet의 KeyboardAvoidingView는 iOS에서만 움직였다

const KEYBOARD = 336;
const WINDOW = 844;

// KeyboardAvoidingView도 같은 이벤트를 들으므로 이벤트마다 들은 함수를 모두 부른다
let handlers: Map<string, ((e: unknown) => void)[]>;
let listen: jest.SpyInstance;
let measure: jest.SpyInstance;
let frame = { y: 0, height: WINDOW };
const was = Platform.OS;

beforeEach(() => {
  handlers = new Map();
  frame = { y: 0, height: WINDOW };
  listen = jest.spyOn(Keyboard, 'addListener').mockImplementation(((
    name: string,
    cb: (e: unknown) => void,
  ) => {
    handlers.set(name, [...(handlers.get(name) ?? []), cb]);
    return { remove: jest.fn() };
  }) as never);
  // 테스트의 View는 jest 목이라 measureInWindow가 아무것도 돌려주지 않는다 — 창 기준 위치를 흉내 낸다
  measure = jest
    .spyOn(View.prototype as unknown as { measureInWindow: () => void }, 'measureInWindow')
    .mockImplementation(function (cb: (x: number, y: number, w: number, h: number) => void) {
      cb(0, frame.y, 390, frame.height);
    } as never);
});

afterEach(() => {
  Platform.OS = was;
  listen.mockRestore();
  measure.mockRestore();
});

const emit = (name: string, e: unknown) =>
  act(async () => (handlers.get(name) ?? []).forEach((cb) => cb(e)));
const showKeyboard = () =>
  emit(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', {
    endCoordinates: { screenY: WINDOW - KEYBOARD, height: KEYBOARD, screenX: 0, width: 390 },
  });
const hideKeyboard = () => emit(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', {});

type Node = { props: { style?: unknown }; children: (Node | string)[] };
const walk = (node: Node): number[] => {
  const own = StyleSheet.flatten(node.props.style as never) as { paddingBottom?: unknown } | null;
  const mine = typeof own?.paddingBottom === 'number' ? [own.paddingBottom] : [];
  return [...mine, ...node.children.flatMap((c) => (typeof c === 'string' ? [] : walk(c)))];
};
/** 그려진 화면의 View들이 가진 아래 여백(paddingBottom) 값 */
const paddings = () => walk(screen.root as unknown as Node);

describe('useKeyboardInset — 공용 훅(스터디룸에서 옮김)', () => {
  it('화면 아래끝과 키보드 위끝이 겹치는 만큼만 계산한다', () => {
    expect(keyboardOverlap({ y: 0, height: 844 }, 844 - 336)).toBe(336);
    expect(keyboardOverlap({ y: 54, height: 790 }, 844 - 336)).toBe(336);
    expect(keyboardOverlap({ y: 0, height: 400 }, 600)).toBe(0);
  });

  it('끄면(enabled=false) 키보드를 듣지 않고 0을 돌려준다', async () => {
    Platform.OS = 'android';
    const ref = { current: {} as View };
    const { result } = await renderHook(() => useKeyboardInset(ref, false));
    expect(listen).not.toHaveBeenCalled();
    expect(result.current).toBe(0);
  });

  it('안드로이드는 keyboardDidShow 하나만 듣는다(같은 이벤트를 두 번 듣지 않는다)', async () => {
    Platform.OS = 'android';
    const ref = { current: new (View as unknown as new () => View)() };
    await renderHook(() => useKeyboardInset(ref));
    const events = listen.mock.calls.map((c) => c[0]);
    expect(events.filter((e) => e === 'keyboardDidShow')).toHaveLength(1);
    expect(events).toContain('keyboardDidHide');
  });
});

describe('Screen — 안드로이드에서 키보드만큼 아래를 띄운다', () => {
  it('키보드가 뜨면 겹친 높이만큼 아래 여백을 주고, 내려가면 없앤다', async () => {
    Platform.OS = 'android';
    await renderScreen(
      <Screen>
        <Text>본문</Text>
      </Screen>,
    );
    expect(paddings()).not.toContain(KEYBOARD);
    await showKeyboard();
    expect(paddings()).toContain(KEYBOARD);
    await hideKeyboard();
    expect(paddings()).not.toContain(KEYBOARD);
  });

  it('탭 막대 위에서 끝나는 화면은 탭 막대가 가리던 만큼을 빼고 띄운다(탭 높이를 두 번 더하지 않는다)', async () => {
    Platform.OS = 'android';
    frame = { y: 0, height: WINDOW - 83 }; // 탭 막대 83 위에서 끝난다
    await renderScreen(
      <Screen>
        <Text>본문</Text>
      </Screen>,
    );
    await showKeyboard();
    expect(paddings()).toContain(KEYBOARD - 83);
    expect(paddings()).not.toContain(KEYBOARD);
  });

  it('키보드가 올라온 동안 아래 버튼 줄은 홈 표시줄 여백 대신 12만 둔다', async () => {
    Platform.OS = 'android';
    await renderScreen(
      <Screen footer={<Text>저장</Text>}>
        <Text>본문</Text>
      </Screen>,
    );
    // test-utils의 홈 표시줄 34 + 12
    expect(paddings()).toContain(46);
    await showKeyboard();
    expect(paddings()).toEqual(expect.arrayContaining([KEYBOARD, 12]));
    expect(paddings()).not.toContain(46);
  });

  it('화면이 키보드를 직접 다루면(avoidKeyboard=false · 스터디룸) 공용 여백을 주지 않는다', async () => {
    Platform.OS = 'android';
    await renderScreen(
      <Screen avoidKeyboard={false}>
        <Text>본문</Text>
      </Screen>,
    );
    await showKeyboard();
    expect(measure).not.toHaveBeenCalled();
    expect(paddings()).not.toContain(KEYBOARD);
  });

  it('iOS는 지금처럼 KeyboardAvoidingView(padding)가 맡고, 직접 재서 한 번 더 띄우지 않는다', async () => {
    Platform.OS = 'ios';
    await renderScreen(
      <Screen>
        <Text>본문</Text>
      </Screen>,
    );
    await showKeyboard();
    expect(measure).not.toHaveBeenCalled();
    expect(paddings()).not.toContain(KEYBOARD);
  });
});

describe('Sheet — 안드로이드에서 키보드만큼 시트를 올린다', () => {
  it('키보드가 뜨면 시트 아래 여백이 키보드 높이 + 12가 되고, 내려가면 처음으로 돌아간다', async () => {
    Platform.OS = 'android';
    await renderScreen(
      <Sheet open onClose={() => {}}>
        <Text>친구 추가</Text>
      </Sheet>,
    );
    // 홈 표시줄 34 + 12 = 46 (최소 28)
    expect(paddings()).toContain(46);
    await showKeyboard();
    expect(paddings()).toContain(KEYBOARD + 12);
    expect(paddings()).not.toContain(46);
    await hideKeyboard();
    expect(paddings()).toContain(46);
  });

  it('iOS 시트는 지금처럼 KeyboardAvoidingView가 맡는다', async () => {
    Platform.OS = 'ios';
    await renderScreen(
      <Sheet open onClose={() => {}}>
        <Text>친구 추가</Text>
      </Sheet>,
    );
    await showKeyboard();
    expect(measure).not.toHaveBeenCalled();
    expect(paddings()).not.toContain(KEYBOARD + 12);
  });
});
