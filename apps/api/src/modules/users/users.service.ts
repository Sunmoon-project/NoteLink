import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Types, type Model } from 'mongoose';

import { User } from '../auth/schemas/user.schema.js';
import { toAppUser } from '../auth/to-app-user.js';
import type { UpdateProfileDto } from './dto/update-profiile.dto.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
  ) {}

  async interestCategories() {
    const categories = await this.userModel.db
      .collection('categories')
      .find({ ownerId: null, isActive: true, deletedAt: null })
      .sort({ sortOrder: 1, _id: 1 })
      .toArray();
    return categories.map((category) => ({
      _id: String(category._id),
      name: category.name,
      parentId: category.parentId ? String(category.parentId) : null,
    }));
  }

  async getMe(userId: string) {
    if (!isValidObjectId(userId)) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: '사용자를 찾을 수 없습니다.',
      });
    }
    const user = await this.userModel.findOne({
      _id: new Types.ObjectId(userId),
      deletedAt: null,
    });

    if (!user) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: '사용자를 찾을 수 없습니다.',
      });
    }
    return toAppUser(user);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (!isValidObjectId(userId)) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: '사용자를 찾을 수 없습니다.',
      });
    }

    const changes: Record<string, unknown> = {};
    if (dto.nickname !== undefined) changes.nickname = dto.nickname;
    if (dto.learnerType !== undefined) changes.learnerType = dto.learnerType;
    if (dto.interestCategoryIds !== undefined) {
      const categoryIds = dto.interestCategoryIds.map((id) => new Types.ObjectId(id));
      const categoryCount = await this.userModel.db.collection('categories').countDocuments({
        _id: { $in: categoryIds },
        isActive: true,
        deletedAt: null,
      });
      if (categoryCount !== categoryIds.length) {
        throw new BadRequestException({
          code: 'INVALID_CATEGORY',
          message: '사용할 수 없는 관심 분야가 있습니다.',
        });
      }
      changes.interestCategoryIds = categoryIds;
    }
    if (dto.settings !== undefined) {
      for (const [key, value] of Object.entries(dto.settings)) {
        if (value !== undefined) changes[`settings.${key}`] = value;
      }
    }
    if (!Object.keys(changes).length) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: '수정할 항목이 없습니다.' });
    }

    try {
      const user = await this.userModel.findOneAndUpdate(
        { _id: new Types.ObjectId(userId), deletedAt: null },
        {
          $set: changes,
        },
        { new: true, runValidators: true },
      );

      if (!user) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: '사용자를 찾을 수 없습니다.',
        });
      }

      return toAppUser(user);
    } catch (error) {
      // nickname에는 유일 인덱스가 있으므로 DB에서도 중복을 막아줌.
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 11000 &&
        'keyPattern' in error &&
        typeof error.keyPattern === 'object' &&
        error.keyPattern !== null &&
        'nickname' in error.keyPattern
      ) {
        throw new ConflictException({
          code: 'NICKNAME_TAKEN',
          message: '이미 사용 중인 닉네임 입니다.',
        });
      }
      throw error;
    }
  }
}
