// 디자인 규격 (tailwind.config.js와 앱 코드가 같이 쓴다)
// 화면에서는 임의 값(text-[13px], h-[50px], 색 hex) 대신 아래 이름만 쓴다.

/** 색 — 글자색은 흰 · 캔버스 · 채움 · 크림 · 민트 배경에서 4.5:1 이상 (sub · danger · blue 조정) */
const colors = {
  canvas: '#f3f4f1', // 화면 바탕. 그 위에 테두리 없는 흰 카드를 올린다
  fill: '#eceee9', // 흰 카드 안의 입력 · 세그먼트 · 진행 막대 바탕
  cream: '#f1ede1', // 온보딩 · 빈 화면에만
  'cream-2': '#e8e2d1',
  line: '#e7e3d7',
  brand: '#3b6e5b',
  'brand-2': '#2f5a4a',
  mint: '#e4ede8',
  ink: '#1f2328',
  sub: '#5f6569',
  night: '#24282c',
  sun: '#f2b532',
  'sun-ink': '#8a6100',
  danger: '#b8403a',
  blue: '#2a62c4',
  orange: '#e8902c', // 가로 자동 측정 타이머 · 녹음 파형
  correct: '#5b74d6', // 퀴즈 정답 (FR-50-03)
  'correct-soft': '#9aa6dd',
  peach: '#eecaa6', // 퀴즈 아바타 배경
  // 간편 로그인 버튼 — 각 회사 로그인 버튼 규격의 바탕색
  kakao: '#fee500',
  naver: '#03c75a',
};

/**
 * 글자 크기 [크기, { 줄높이, 자간 }] — iOS 텍스트 스타일 이름을 따른다.
 * 자간: 작은 글자(11~13)는 +0.2px로 뭉치지 않게, 제목(20~)은 조금씩 좁히고
 * 큰 숫자(44~)는 -2% 안팎으로 조인다 (디자인 점검 · Refero 글자 규칙).
 * 위계는 네 단계로 쓴다: 숫자 · 화면 제목(display~page) / 구획 제목(title3 · headline) /
 * 본문(body · callout · subhead) / 보조(footnote · caption · caption2).
 */
const t = (size, lineHeight, letterSpacing = '0px') => [size, { lineHeight, letterSpacing }];
const fontSize = {
  caption2: t('11px', '14px', '0.2px'), // 배지 · 아주 작은 표시
  caption: t('12px', '16px', '0.2px'), // 보조 설명 · 날짜
  footnote: t('13px', '18px', '0.1px'), // 목록 보조 줄 · 안내
  subhead: t('14px', '20px'), // 목록 본문 · 칩
  callout: t('15px', '22px'), // 버튼 · 입력
  body: t('16px', '24px'), // 본문
  headline: t('17px', '24px', '-0.1px'), // 카드 · 시트 제목
  title3: t('20px', '26px', '-0.2px'), // 섹션 제목
  title2: t('22px', '28px', '-0.3px'), // 화면 제목
  page: t('26px', '32px', '-0.5px'), // 탭 화면 제목
  title1: t('28px', '34px', '-0.5px'), // 큰 화면 제목 · 강조 숫자
  large: t('34px', '40px', '-0.7px'), // 결과 화면 큰 숫자
  display: t('44px', '52px', '-1px'), // 타이머
  'display-lg': t('64px', '72px', '-1.5px'), // 홈 타이머
  timer: t('84px', '92px', '-2px'), // 가로 측정 타이머
  'timer-xl': t('120px', '128px', '-3px'),
};

/** 컨트롤 높이: 주요 버튼 · 입력 52 / 작은 버튼 · 검색 44 / 칩 36 (터치 영역은 44로 넓힌다) */
const spacing = {
  'control-lg': '52px',
  control: '44px',
  'control-sm': '36px',
};

/** 모서리: 카드 20 / 시트 · 다이얼로그 28 (입력 12 · 버튼 16은 rounded-xl · rounded-2xl) */
const borderRadius = {
  card: '20px',
  sheet: '28px',
};

/** 아이콘 크기 (lucide size) */
const icon = { xs: 14, sm: 16, md: 20, lg: 24, xl: 32 }; // xl: 빈 화면 · 결과 화면의 큰 아이콘

/** 모션: 스프링 · 시간. 들어올 때보다 나갈 때 짧게 */
const motion = {
  // 눌림은 튕기지 않게 임계 감쇠에 가깝게 둔다
  press: { scale: 0.98, damping: 34, stiffness: 320 },
  enter: 280,
  exit: 180,
  stagger: 40,
};

// 그림자는 화면마다 주인공 하나에만 (홈 집중 카드). React Native boxShadow 값
const shadow = { focus: '0px 8px 24px rgba(31, 35, 40, 0.16)' };

const fontFamily = 'Pretendard';

module.exports = { colors, fontSize, spacing, borderRadius, icon, motion, shadow, fontFamily };
