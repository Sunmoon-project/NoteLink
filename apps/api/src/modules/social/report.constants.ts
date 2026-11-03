/** 신고 유형 (packages/shared ReportType) */
export const REPORT_TYPES = ['abusive_language', 'spam', 'disturbing', 'obscene', 'other'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** 신고 처리 상태 */
export const REPORT_STATUS = {
  PENDING: 'pending', // 접수됨
  IN_REVIEW: 'in_review', // 검토 중
  RESOLVED: 'resolved', // 해결됨
  DISMISSED: 'dismissed', // 기각됨
} as const;

export type ReportStatus = (typeof REPORT_STATUS)[keyof typeof REPORT_STATUS];
