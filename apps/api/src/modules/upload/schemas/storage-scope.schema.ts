import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

export type StorageScopeDocument = HydratedDocument<StorageScope>;

/**
 * 이 DB의 저장소 구분값. 여러 DB(배포 · 각자의 로컬)가 같은 Blob 컨테이너를 쓰므로,
 * DB 기록을 보고 지우는 작업은 이 값이 같은 Blob만 다룬다. DB마다 문서 하나
 */
@Schema({ collection: 'storage_scopes' })
export class StorageScope {
  @Prop({ type: String })
  _id: string;

  @Prop({ required: true, type: String })
  scope: string;
}

export const StorageScopeSchema = SchemaFactory.createForClass(StorageScope);
