import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { UPLOAD_RULES } from '@notelink/shared';
import { isValidObjectId } from 'mongoose';
import { BlobStorageService } from './blob-storage.service.js';
import { CreateUploadDto } from './dto/create-upload.dto.js';

const REPORT_IMAGE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
};

@Injectable()
export class UploadsService {
  constructor(private readonly storage: BlobStorageService) {}

  async issue(userId: string, input: CreateUploadDto) {
    if (!isValidObjectId(userId))
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: '다시 로그인해 주세요.' });
    const rule = UPLOAD_RULES[input.kind];
    const extension = input.fileName.split('.').pop()?.toLowerCase() ?? '';
    if (
      (input.purpose === 'report' &&
        (input.kind !== 'image' || REPORT_IMAGE_TYPES[extension] !== input.contentType)) ||
      !(rule.exts as readonly string[]).includes(extension) ||
      !(rule.types as readonly string[]).includes(input.contentType) ||
      input.sizeBytes > rule.maxBytes
    ) {
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: '파일 형식이나 크기가 올바르지 않습니다.',
      });
    }
    const owner = userId.toLowerCase();
    const prefix =
      input.purpose === 'report' ? `reports/${owner}` : `uploads/${input.kind}/${owner}`;
    return this.storage.createUpload(`${prefix}/${randomUUID()}.${extension}`);
  }
}
