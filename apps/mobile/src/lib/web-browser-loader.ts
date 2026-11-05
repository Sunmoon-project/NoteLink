/** 네이티브 모듈이 없는 옛 개발 빌드에서도 앱이 뜨도록 누를 때 읽는다. */
export const loadBrowser = () => import('expo-web-browser');
export const loadCrypto = () => import('expo-crypto');
