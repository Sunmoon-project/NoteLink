import Svg, { Path } from 'react-native-svg';

// 간편 로그인 버튼의 회사 로고 — 각 회사 로그인 버튼 규격의 심볼을 그대로 그린다

/** 카카오 말풍선 심볼 (노란 바탕 위 검정) */
export const KakaoLogo = ({ size = 18 }: { size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
    <Path
      fill="#000"
      fillOpacity={0.9}
      d="M12 3C6.48 3 2 6.58 2 11c0 2.83 1.86 5.32 4.66 6.74l-1.18 4.3c-.1.38.33.68.66.46l5.12-3.4c.24.02.49.03.74.03 5.52 0 10-3.58 10-8S17.52 3 12 3z"
    />
  </Svg>
);

/** 네이버 N 심볼 (초록 바탕 위 흰색) */
export const NaverLogo = ({ size = 16 }: { size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden>
    <Path fill="#fff" d="M16.27 12.84 7.38 0H0v24h7.73V11.16L16.62 24H24V0h-7.73z" />
  </Svg>
);

/** Google G 심볼 (네 가지 색) */
export const GoogleLogo = ({ size = 18 }: { size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 48 48" accessibilityElementsHidden>
    <Path
      fill="#EA4335"
      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
    />
    <Path
      fill="#4285F4"
      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
    />
    <Path
      fill="#FBBC05"
      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
    />
    <Path
      fill="#34A853"
      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
    />
  </Svg>
);
