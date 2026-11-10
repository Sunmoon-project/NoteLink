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
export class UsersService{
    constructor(
        @InjectModel(User.name)
        private readonly userModel: Model<User>,
    ) {}

    async getMe(userId: string){
        if(!isValidObjectId(userId)) {
            throw new NotFoundException({
                code: 'NOT_FOUND',
                message: '사용자를 찾을 수 없습니다.',
            });
        }
        const user = await this.userModel.findOne({
            _id: new Types.ObjectId(userId),
            deletedAt: null,
        });

        if (!user){
            throw new NotFoundException({
                code: "NOT_FOUND",
                message: '사용자를 찾을 수 없습니다.',
            });
        }
        return toAppUser(user);
    }

    async updateProfile(userId: string, dto: UpdateProfileDto){
        if (!isValidObjectId(userId)){
            throw new NotFoundException({
                code: 'NOT_FOUND',
                message: '사용자를 찾을 수 없습니다.',
            });
        }

        const categoryIds = dto.interestCategoryIds.map(
            (id) => new Types.ObjectId(id),
        );

        // categories 컬렉션에 실제로 존재하는 ID만 허용.
        const categoryCount = await this.userModel.db
            .collection('categories')
            .countDocuments({ _id: { $in: categoryIds } });
        
        if (categoryCount !== categoryIds.length){
            throw new BadRequestException({
                code: 'INVALID_CATEGORY',
                message: '존재하지 않는 관심 분야가 있습니다.',
            });
        }

        try{
            const user = await this.userModel.findOneAndUpdate(
                { _id: new Types.ObjectId(userId), deletedAt: null },
                {
                    $set: {
                        nickname: dto.nickname,
                        learnerType: dto.learnerType,
                        interestCategoryIds: categoryIds,
                    },
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
                error.code === 11000
            ){
                throw new ConflictException({
                    code: "NICKNAME_TAKEN",
                    message: '이미 사용 중인 닉네임 입니다.',
                });
            }
            throw error
        }
    }
}

