import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Types, type Model } from 'mongoose';

import { User } from '../schemas/user.schema.js';
import { REQUIRED_TERM_CODES, TERM_CODES, TERMS_REQUIRED, TERMS_VERSION } from './terms.constants.js';

interface StoredAgreement {
  termCode: string;
  version: string;
  agreed: boolean;
  agreedAt: Date;
}

@Injectable()
export class TermsService {
  constructor(@InjectModel(User.name) private readonly userModel: Model<User>) {}

  /**
   * 사용자가 동의한 약관을 저장한다(FR-01-05). 필수 약관이 하나라도 빠지면 400 TERMS_REQUIRED.
   * 모든 약관 코드의 동의 여부를 남기고(선택 약관은 agreed: false도 기록), 다시 호출하면 값을 덮어쓴다.
   * 동의 여부가 그대로인 약관은 처음 동의한 시각(agreedAt)을 유지한다.
   * 사용자가 없거나 삭제됐으면 false.
   */
  async agree(userId: string, termCodes: string[]): Promise<boolean> {
    const agreed = new Set(termCodes);
    if (REQUIRED_TERM_CODES.some((code) => !agreed.has(code))) {
      throw new BadRequestException({
        code: TERMS_REQUIRED,
        message: '필수 약관에 모두 동의해 주세요.',
      });
    }
    if (!isValidObjectId(userId)) return false;
    const _id = new Types.ObjectId(userId);

    const user = await this.userModel
      .findOne({ _id, deletedAt: null }, { termAgreements: 1 })
      .lean<{ termAgreements?: StoredAgreement[] }>();
    if (!user) return false;

    const before = new Map((user.termAgreements ?? []).map((t) => [t.termCode, t]));
    const now = new Date();
    const termAgreements: StoredAgreement[] = TERM_CODES.map((termCode) => {
      const isAgreed = agreed.has(termCode);
      const prev = before.get(termCode);
      const unchanged = prev !== undefined && prev.agreed === isAgreed && prev.version === TERMS_VERSION;
      return {
        termCode,
        version: TERMS_VERSION,
        agreed: isAgreed,
        agreedAt: unchanged ? prev.agreedAt : now,
      };
    });

    const result = await this.userModel.updateOne({ _id, deletedAt: null }, { $set: { termAgreements } });
    return result.matchedCount > 0;
  }
}
