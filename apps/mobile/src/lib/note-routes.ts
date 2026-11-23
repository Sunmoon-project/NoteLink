import { router } from 'expo-router';
import type { MaterialKind } from '@notelink/shared';

// 노트 상세로 가는 경로(#674).
// 탭 밖 화면(방 · 채팅 · 알림함 등 루트 Stack)에서 `/(tabs)/note/…` 를 push 하면 루트 Stack 에 (tabs) 가 하나 더 쌓인다.
// 새 (tabs) 의 노트 탭에는 상세 하나만 있어 뒤로 가면 홈으로 가고, 노트 탭은 그 상세에 고정된다.
// 그래서 남의 노트(방 · 친구 공유)는 탭 밖 `/note-view/…` 로 열고, 내 노트 탭으로 갈 때는 있던 (tabs) 로 돌아간다

const DETAIL = { handwriting: 'hand', recording: 'rec', document: 'doc' } as const;
type Kind = MaterialKind | null | undefined;
// 모르는 종류(새 종류 · 옛 데이터)도 예전처럼 문서 화면으로 연다
const detail = (kind: Kind): (typeof DETAIL)[MaterialKind] =>
  kind && Object.prototype.hasOwnProperty.call(DETAIL, kind) ? DETAIL[kind] : 'doc';

/** 탭 밖에서 여는 노트 보기(뒤로 가면 연 화면으로 돌아온다). 종류를 모르면 문서 화면 */
export const noteViewPath = (kind: Kind) => `/note-view/${detail(kind)}/[id]` as const;

/** 노트 탭 안의 내 노트 상세 */
export const noteTabPath = (kind: Kind) => `/(tabs)/note/${detail(kind)}/[id]` as const;

/**
 * 탭 밖 화면에서 내 노트 탭의 상세로 간다. 있던 (tabs) 로 돌아가(dismissTo) 노트 탭에서 상세를 연다.
 * withAnchor 로 노트 목록을 아래에 깔아, 노트 탭을 아직 안 열었어도 뒤로 가면 노트 목록이 나온다.
 * (폴더로 dismissTo 한 뒤 상세를 push 하면, 노트 탭이 아직 그려지지 않았을 때 상세 하나만 남아 뒤로 가기가 홈으로 간다)
 */
export function openMyNote(kind: Kind, id: string) {
  router.dismissTo({ pathname: noteTabPath(kind), params: { id } }, { withAnchor: true });
}
