import { IsIn } from 'class-validator';

import { REPORT_STATUS } from '../report.constants.js';
import type { ReportStatus } from '../report.constants.js';

const STATUS_VALUES = Object.values(REPORT_STATUS);

/** 관리자가 신고 상태를 변경할 때 쓰는 입력 */
export class UpdateReportStatusDto {
  @IsIn(STATUS_VALUES)
  status: ReportStatus;
}
