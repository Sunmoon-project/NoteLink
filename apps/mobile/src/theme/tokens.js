// 디자인 규격 (tailwind.config.js와 앱 코드가 같이 쓴다)
// 화면에서는 임의 값(text-[13px], h-[50px], 색 hex) 대신 아래 이름만 쓴다.

/** 색 — 글자색은 흰 · 크림 · 민트 배경에서 4.5:1 이상 (sub · danger · blue 조정) */
const colors = {
  cream: '#f1ede1',
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
};

/** 글자 크기 [크기, 줄높이] — iOS 텍스트 스타일 이름을 따른다 */
const fontSize = {
  caption2: ['11px', '14px'], // 배지 · 아주 작은 표시
  caption: ['12px', '16px'], // 보조 설명 · 날짜
  footnote: ['13px', '18px'], // 목록 보조 줄 · 안내
  subhead: ['14px', '20px'], // 목록 본문 · 칩
  callout: ['15px', '22px'], // 버튼 · 입력
  body: ['16px', '24px'], // 본문
  headline: ['17px', '24px'], // 카드 · 시트 제목
  title3: ['20px', '26px'], // 섹션 제목
  title2: ['22px', '28px'], // 화면 제목
  title1: ['28px', '34px'], // 큰 화면 제목 · 강조 숫자
  large: ['34px', '40px'], // 결과 화면 큰 숫자
  display: ['44px', '52px'], // 타이머
  'display-lg': ['64px', '72px'], // 홈 타이머
  timer: ['84px', '92px'], // 가로 측정 타이머
  'timer-xl': ['120px', '128px'],
};

/** 컨트롤 높이: 주요 버튼 · 입력 52 / 작은 버튼 · 검색 44 / 칩 36 (터치 영역은 44로 넓힌다) */
const spacing = {
  'control-lg': '52px',
  control: '44px',
  'control-sm': '36px',
};

/** 아이콘 크기 (lucide size) */
const icon = { xs: 14, sm: 16, md: 20, lg: 24, xl: 32 }; // xl: 빈 화면 · 결과 화면의 큰 아이콘

/** 모션: 스프링 · 시간. 들어올 때보다 나갈 때 짧게 */
const motion = {
  press: { scale: 0.97, damping: 18, stiffness: 320 },
  enter: 280,
  exit: 180,
  stagger: 40,
};

const fontFamily = 'Pretendard';

module.exports = { colors, fontSize, spacing, icon, motion, fontFamily };
