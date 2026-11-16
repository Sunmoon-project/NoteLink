/**
 * 요약(소제목 · 본문) 상한. 편집 저장(PATCH /materials/:id 의 summary)의 검증과 자동 요약 생성(material-sync)이
 * 같은 값을 쓴다: 생성된 요약을 앱이 그대로 고쳐 저장해도 상한에 걸리지 않게
 */
export const SUMMARY_MAX_SECTIONS = 50;
export const SUMMARY_HEADING_MAX = 100;
export const SUMMARY_BODY_MAX = 10000;
