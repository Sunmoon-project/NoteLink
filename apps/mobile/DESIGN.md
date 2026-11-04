# 앱 디자인 규격

값은 `src/theme/tokens.js` 한곳에 있고 Tailwind 클래스 · `ICON` · `MOTION`으로 씁니다.
화면에서 `text-[13px]`, `h-[50px]`, `bg-[#eef1f2]` 같은 임의 값을 쓰지 않습니다.

## 글꼴 · 글자

- 글꼴: Pretendard 400 · 500 · 600 · 700 (SIL OFL, `assets/fonts`). `Text` · `TextInput`은 `@/components/text`에서 가져옵니다.
- 굵기: 제목 `font-bold`, 강조 `font-semibold`, 라벨 `font-medium`, 본문은 지정하지 않음
- 숫자(타이머 · 시간): `tabular-nums`

| 클래스 | 크기/줄높이 | 쓰는 곳 |
| --- | --- | --- |
| `text-caption2` | 11/14 | 배지 |
| `text-caption` | 12/16 | 보조 설명 · 날짜 |
| `text-footnote` | 13/18 | 목록 보조 줄 · 안내 |
| `text-subhead` | 14/20 | 목록 본문 · 칩 |
| `text-callout` | 15/22 | 버튼 · 입력 |
| `text-body` | 16/24 | 본문 |
| `text-headline` | 17/24 | 카드 · 시트 제목 |
| `text-title3` | 20/26 | 섹션 제목 |
| `text-title2` | 22/28 | 화면 제목 |
| `text-title1` | 28/34 | 큰 화면 제목 · 강조 숫자 |
| `text-large` | 34/40 | 결과 화면 큰 숫자 |
| `text-display` · `display-lg` · `timer` · `timer-xl` | 44 · 64 · 84 · 120 | 타이머 전용 |

## 크기 · 간격

- 컨트롤 높이: `h-control-lg` 52(주요 버튼 · 입력) / `h-control` 44(작은 버튼 · 검색 · 뒤로 · 닫기) / `h-control-sm` 36(칩 · 세그먼트, 터치 영역은 hitSlop으로 44)
- 간격: 4의 배수(Tailwind 기본). 화면 좌우 여백 20(`px-5`)
- 모서리: 입력 · 작은 카드 `rounded-xl`(12), 카드 · 버튼 `rounded-2xl`(16), 시트 · 다이얼로그 `rounded-3xl`(24), 칩 `rounded-full`
- 아이콘: Lucide만 씁니다(이모지 아이콘 금지). 크기는 `ICON.xs` 14 · `sm` 16 · `md` 20 · `lg` 24 · `xl` 32

## 색

`brand` 주색, `cream` · `mint` 배경, `ink` 글자, `sub` 보조 글자, `danger` 오류, `sun` 강조.
`sub` · `danger` · `blue`는 흰 · 크림 · 민트 배경에서 4.5:1 이상이 되도록 맞췄습니다. 새 색이 필요하면 `tokens.js`에 이름을 붙여 추가합니다.

## 모션

- 눌림: `Btn` · `Card(onPress)` · `Chip` · `Dashed`는 `Tap`으로 0.97까지 스프링 축소. 직접 만드는 버튼도 `Tap`을 씁니다
- 시트: 스프링으로 올라오고 아래로 내려가며 닫힘(180ms). 다이얼로그: 스프링 확대 등장
- 목록: `Group`의 행, 또는 `Appear index={i}`로 40ms씩 차례로 등장(8개 이후는 같이)
- 진행 막대: transform으로 280ms 채움
- 화면 전환: 오른쪽에서 들어옴(280ms), 탭 전환: shift
- 시간 · 스프링 값은 `MOTION` 토큰만 씁니다. Reanimated가 시스템의 '동작 줄이기'를 따릅니다
