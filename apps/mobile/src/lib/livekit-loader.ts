/** 기기 저장 모드와 미디어 없는 빌드에서 네이티브 SDK를 평가하지 않도록 연결 시점에 읽는다. */
export const loadMedia = () => import('./livekit-native');
