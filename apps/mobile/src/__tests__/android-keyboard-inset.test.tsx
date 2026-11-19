import { useState } from 'react';
import { act, renderHook, screen, waitFor } from '@testing-library/react-native';
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
type LayoutNode = { props: { onLayout?: (e: unknown) => void }; children: (LayoutNode | string)[] };
/** 그려진 View들의 onLayout을 모두 부른다(자리가 바뀐 것처럼) */
const layoutAll = (node = screen.root as unknown as LayoutNode) => {
  node.props.onLayout?.({
    nativeEvent: { layout: { x: 0, y: frame.y, width: 390, height: frame.height } },
    persist: () => {},
  });
  node.children.forEach((c) => typeof c !== 'string' && layoutAll(c));
};

describe('useKeyboardInset — 공용 훅(스터디룸에서 옮김)', () => {
  it('화면 아래끝과 키보드 위끝이 겹치는 만큼만 계산한다', () => {
    expect(keyboardOverlap({ y: 0, height: 844 }, 844 - 336)).toBe(336);
    expect(keyboardOverlap({ y: 54, height: 790 }, 844 - 336)).toBe(336);
    expect(keyboardOverlap({ y: 0, height: 400 }, 600)).toBe(0);
  });

  it('키보드가 이미 떠 있을 때 켜지면 다음 이벤트를 기다리지 않고 바로 잰다', async () => {
    Platform.OS = 'android';
    const visible = jest.spyOn(Keyboard, 'isVisible').mockReturnValue(true);
    const metrics = jest
      .spyOn(Keyboard, 'metrics')
      .mockReturnValue({ screenY: WINDOW - KEYBOARD, height: KEYBOARD, screenX: 0, width: 390 });
    try {
      await renderScreen(
        <Screen>
          <Text>본문</Text>
        </Screen>,
      );
      await waitFor(() => expect(paddings()).toContain(KEYBOARD));
    } finally {
      visible.mockRestore();
      metrics.mockRestore();
    }
  });

  it('키보드가 떠 있는 채로 시트를 열면 시트도 바로 키보드 위로 올라간다', async () => {
    Platform.OS = 'android';
    const visible = jest.spyOn(Keyboard, 'isVisible').mockReturnValue(true);
    const metrics = jest
      .spyOn(Keyboard, 'metrics')
      .mockReturnValue({ screenY: WINDOW - KEYBOARD, height: KEYBOARD, screenX: 0, width: 390 });
    try {
      let setOpen: (open: boolean) => void = () => {};
      function Host() {
        const [open, set] = useState(false);
        setOpen = set;
        return (
          <Sheet open={open} onClose={() => {}}>
            <Text>할 일 추가</Text>
          </Sheet>
        );
      }
      await renderScreen(<Host />);
      await act(async () => setOpen(true));
      await waitFor(() => expect(paddings()).toContain(KEYBOARD + 12));
    } finally {
      visible.mockRestore();
      metrics.mockRestore();
    }
  });

  it('바로 재기 전에 키보드가 내려가면 여백을 주지 않는다', async () => {
    Platform.OS = 'android';
    const visible = jest.spyOn(Keyboard, 'isVisible').mockReturnValue(true);
    const metrics = jest
      .spyOn(Keyboard, 'metrics')
      .mockReturnValue({ screenY: WINDOW - KEYBOARD, height: KEYBOARD, screenX: 0, width: 390 });
    try {
      await renderScreen(
        <Screen>
          <Text>본문</Text>
        </Screen>,
      );
      await hideKeyboard();
      await act(async () => new Promise((r) => setTimeout(r, 50)));
      expect(paddings()).not.toContain(KEYBOARD);
    } finally {
      visible.mockRestore();
      metrics.mockRestore();
    }
  });

  it('잰 값이 키보드가 내려간 뒤에 돌아오면 버린다(내려간 뒤 빈 여백이 남지 않는다)', async () => {
    Platform.OS = 'android';
    const late: (() => void)[] = [];
    measure.mockImplementation(function (cb: (x: number, y: number, w: number, h: number) => void) {
      late.push(() => cb(0, frame.y, 390, frame.height));
    } as never);
    await renderScreen(
      <Screen>
        <Text>본문</Text>
      </Screen>,
    );
    await showKeyboard();
    await hideKeyboard();
    await act(async () => late.forEach((run) => run()));
    expect(paddings()).not.toContain(KEYBOARD);
  });

  it('키보드가 떠 있는 동안 잴 View의 자리가 바뀌면(onLayout) 다시 잰다', async () => {
    Platform.OS = 'android';
    frame = { y: 0, height: 0 }; // 아직 자리 잡지 않음
    await renderScreen(
      <Screen>
        <Text>본문</Text>
      </Screen>,
    );
    await showKeyboard();
    expect(paddings()).not.toContain(KEYBOARD);
    frame = { y: 0, height: WINDOW };
    await act(async () => layoutAll());
    expect(paddings()).toContain(KEYBOARD);
    // 창이 키보드만큼 줄면(겹침 없음) 여백을 없앤다 — 두 번 띄우지 않는다
    frame = { y: 0, height: WINDOW - KEYBOARD };
    await act(async () => layoutAll());
    expect(paddings()).not.toContain(KEYBOARD);
  });

  it('끄면(enabled=false) 키보드를 듣지 않고 0을 돌려준다', async () => {
    Platform.OS = 'android';
    const ref = { current: {} as View };
    const { result } = await renderHook(() => useKeyboardInset(ref, false));
    expect(listen).not.toHaveBeenCalled();
    expect(result.current[0]).toBe(0);
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

  it('키보드가 화면 아래를 조금만 덮으면 아래 버튼 줄은 덮이지 않은 여백만큼 남긴다', async () => {
    Platform.OS = 'android';
    frame = { y: 0, height: WINDOW - KEYBOARD + 10 }; // 아래끝 10만 키보드에 덮임
    await renderScreen(
      <Screen footer={<Text>저장</Text>}>
        <Text>본문</Text>
      </Screen>,
    );
    await showKeyboard();
    // 여백 46 중 키보드가 덮은 10을 뺀 36
    expect(paddings()).toEqual(expect.arrayContaining([10, 36]));
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

  it('보이지 않는 화면(스택 뒤 · 다른 탭)은 재지 않는다', async () => {
    Platform.OS = 'android';
    globalThis.mockFocused = false;
    try {
      await renderScreen(
        <Screen>
          <Text>본문</Text>
        </Screen>,
      );
      await showKeyboard();
      expect(measure).not.toHaveBeenCalled();
      expect(paddings()).not.toContain(KEYBOARD);
    } finally {
      globalThis.mockFocused = undefined;
    }
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
