import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type HolidayFetchDocument = HydratedDocument<HolidayFetch>;

/**
 * 해마다 공휴일을 외부에서 "다 받아 저장했다"는 표시. 이 표시가 있어야 그 해의 public_holidays를 믿고 쓴다.
 * 공휴일 저장이 모두 끝난 다음에만 쓰므로, 저장이 중간에 실패하면 표시가 없어 다음 조회 때 다시 받는다.
 */
@Schema({ collection: 'holiday_fetches', timestamps: false })
export class HolidayFetch {
  @Prop({ required: true, type: Number })
  _id: number; // 연도(예: 2026)

  @Prop({ required: true, type: Date })
  fetchedAt: Date; // 마지막으로 다 받은 시각

  @Prop({ required: true, type: Number })
  count: number; // 그때 받은 공휴일 수
}

export const HolidayFetchSchema = SchemaFactory.createForClass(HolidayFetch);
