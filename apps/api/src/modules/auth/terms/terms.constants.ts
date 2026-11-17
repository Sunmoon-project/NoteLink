/** 앱 약관 화면(apps/mobile features/auth)이 보내는 약관 코드. 앞의 둘은 필수, 마지막은 선택 */
export const TERM_CODES = ['service', 'privacy', 'marketing'] as const;
export type TermCode = (typeof TERM_CODES)[number];

/** 동의하지 않으면 가입을 진행할 수 없는 약관(FR-01-05) */
export const REQUIRED_TERM_CODES: readonly TermCode[] = ['service', 'privacy'];

/** 약관 개정 이력용 버전. 약관 내용이 바뀌면 올린다 */
export const TERMS_VERSION = '1.0';

/** 필수 약관에 동의하지 않았을 때의 오류 코드 */
export const TERMS_REQUIRED = 'TERMS_REQUIRED';
