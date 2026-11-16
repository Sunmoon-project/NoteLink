import { seoul } from './dates';

/** 스캔한 문서의 기본 제목: "11월 12일 스캔"(서울 날짜) */
export const scanTitle = (now = Date.now()) => {
  const d = seoul(now);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 스캔`;
};
