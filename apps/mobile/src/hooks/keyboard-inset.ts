import { useEffect, useState, type RefObject } from 'react';
import { Keyboard, Platform, type KeyboardEvent, type View } from 'react-native';

/** 화면 아래끝(창 기준)과 키보드 위끝이 겹치는 높이. 겹치지 않으면 0 */
export const keyboardOverlap = (frame: { y: number; height: number }, keyboardTop: number) =>
  Math.max(0, Math.round(frame.y + frame.height - keyboardTop));

/**
 * 키보드가 이 화면(ref)을 가리는 높이. 창 기준(measureInWindow)으로 재서 그만큼 띄우게 한다.
 * 안드로이드는 edge-to-edge라 adjustResize가 창을 줄이지 않고, KeyboardAvoidingView는 부모 기준 위치로
 * 계산해 입력줄이 덜 올라갔다(스터디룸 #507에서 실기기로 확인한 방식을 공용으로 옮김, #567).
 * 재는 View 자신에 아래 여백을 주어도 그 View의 크기 · 위치는 바뀌지 않아 다시 재도 값이 같다.
 * enabled가 false면 키보드를 듣지 않고 0을 돌려준다(iOS에서 KeyboardAvoidingView가 맡는 곳 등)
 */
export function useKeyboardInset(ref: RefObject<View | null>, enabled = true) {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const show = (e: KeyboardEvent) => {
      const top = e.endCoordinates.screenY;
      const node = ref.current;
      if (!node) return;
      node.measureInWindow((_x, y, _w, height) => setInset(keyboardOverlap({ y, height }, top)));
    };
    const hide = () => setInset(0);
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
    return () => {
      subs.forEach((sub) => sub.remove());
      setInset(0);
    };
  }, [ref, enabled]);
  return enabled ? inset : 0;
}
