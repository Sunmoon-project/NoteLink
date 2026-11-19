import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Keyboard, Platform, type KeyboardEvent, type View } from 'react-native';

/** 화면 아래끝(창 기준)과 키보드 위끝이 겹치는 높이. 겹치지 않으면 0 */
export const keyboardOverlap = (frame: { y: number; height: number }, keyboardTop: number) =>
  Math.max(0, Math.round(frame.y + frame.height - keyboardTop));

/**
 * 키보드가 이 화면(ref)을 가리는 높이. 창 기준(measureInWindow)으로 재서 그만큼 띄우게 한다.
 * 안드로이드는 edge-to-edge라 adjustResize가 창을 줄이지 않고, KeyboardAvoidingView는 부모 기준 위치로
 * 계산해 입력줄이 덜 올라갔다(스터디룸 #507에서 실기기로 확인한 방식을 공용으로 옮김, #567).
 * 재는 View 자신에 아래 여백을 주어도 그 View의 크기 · 위치는 바뀌지 않아 다시 재도 값이 같다.
 * enabled가 false면 키보드를 듣지 않고 0을 돌려준다(iOS에서 KeyboardAvoidingView가 맡는 곳 등).
 *
 * 돌려주는 onLayout을 잴 View에 붙이면, 키보드가 떠 있는 동안 그 View의 자리가 바뀔 때 다시 잰다
 * (막 열린 시트 Modal이 늦게 자리 잡거나, 창이 키보드만큼 줄어 겹침이 없어진 경우)
 */
export function useKeyboardInset(ref: RefObject<View | null>, enabled = true) {
  const [inset, setInset] = useState(0);
  const remeasure = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled) return;
    // 지금 떠 있는 키보드의 위끝(창 기준). 내려가 있으면 undefined
    let top: number | undefined;
    // 잰 값이 늦게 돌아오는 사이 키보드가 내려가거나 다시 재면 그 값은 버린다(내려간 뒤 여백이 남지 않게)
    let turn = 0;
    let pending: number | undefined;
    const cancel = () => {
      if (pending !== undefined) cancelAnimationFrame(pending);
      pending = undefined;
    };
    const measure = () => {
      const mine = ++turn;
      const node = ref.current;
      if (top === undefined || !node) return;
      const at = top;
      node.measureInWindow((_x, y, _w, height) => {
        if (mine === turn) setInset(keyboardOverlap({ y, height }, at));
      });
    };
    const show = (e: KeyboardEvent) => {
      cancel();
      top = e.endCoordinates.screenY;
      measure();
    };
    const hide = () => {
      cancel();
      top = undefined;
      turn++;
      setInset(0);
    };
    // 안드로이드에는 Will 이벤트가 없다. 키보드 높이가 바뀌면(이모지 · 추천 줄) keyboardDidShow가 다시 온다
    const subs =
      Platform.OS === 'ios'
        ? [
            Keyboard.addListener('keyboardWillShow', show),
            Keyboard.addListener('keyboardWillChangeFrame', show),
            Keyboard.addListener('keyboardWillHide', hide),
          ]
        : [
            Keyboard.addListener('keyboardDidShow', show),
            Keyboard.addListener('keyboardDidHide', hide),
          ];
    // 키보드가 이미 떠 있을 때 켜지면(입력 중에 시트를 열거나 다음 화면으로 감) 다음 이벤트를 기다리지 않고 잰다.
    // 한 프레임 뒤에 재고, 그 뒤 자리가 바뀌면 onLayout이 다시 잰다
    const now = Keyboard.isVisible() ? Keyboard.metrics() : undefined;
    if (now) {
      top = now.screenY;
      pending = requestAnimationFrame(measure);
    }
    remeasure.current = measure;
    return () => {
      cancel();
      turn++;
      remeasure.current = () => {};
      subs.forEach((sub) => sub.remove());
      setInset(0);
    };
  }, [ref, enabled]);
  const onLayout = useCallback(() => remeasure.current(), []);
  return [enabled ? inset : 0, onLayout] as const;
}
