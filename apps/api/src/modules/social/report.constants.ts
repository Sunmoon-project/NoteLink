/** 신고 유형 (발표자료 p.28 reports.reportType) */
export const REPORT_TYPES = ['chat', 'profile', 'behavior'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** 신고 처리 상태 */
export const REPORT_STATUS = {
  PENDING: 'pending', // 접수됨
  IN_REVIEW: 'in_review', // 검토 중
  RESOLVED: 'resolved', // 해결됨
  DISMISSED: 'dismissed', // 기각됨
} as const;

export type ReportStatus = (typeof REPORT_STATUS)[keyof typeof REPORT_STATUS];
