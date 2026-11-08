import { ConflictException, Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types, type Connection, type SortOrder } from 'mongoose';

import type { ShopSort } from '../dto/list-shop-items.dto.js';
import { PointService } from '../point/point.service.js';

import {
    ShopItem,
    type ShopBadge,
    type ShopCategory,
    type ShopItemDocument,
} from '../schemas/shop-item.schema.js';
import { UserItem, type UserItemDocument } from '../schemas/user-item.schema.js';

/** 앱에 내려주는 아이템 한 건 (공유 계약 ShopItem과 같은 모양) */
export interface ShopItemView {
    _id: string;
    category: ShopCategory;
    name: string;
    description: string | null;
    price: number;
    avatarStyle: string | null;
    thumbnailUrl: string | null;
    assetUrl: string;
    purchaseCount: number;
    isActive: boolean;
    isDefault: boolean;
    badge: ShopBadge | null;
}

/** 앱에 내려주는 내 아이템 한 건 (공유 계약 UserItem과 같은 모양) */
export interface UserItemView {
    _id: string;
    itemId: string;
    itemCategory: ShopCategory;
    isOwned: boolean;
    isWished: boolean;
    isEquipped: boolean;
    acquiredAt: string | null;
}

// 앱이 코드 안에 직접 갖고 있는 기본 아바타의 ID. DB 아이템이 아니라서 보유 행도 없다
export const BASE_AVATAR_ID = 'base';

// DB에서 꺼낸 문서 (lean: Mongoose 기능 없이 순수 객체)
type ShopItemLean = ShopItem & { _id: Types.ObjectId };
type UserItemLean = UserItem & { _id: Types.ObjectId };

// 정렬 기준 → MongoDB 정렬 조건. 값이 같으면 최신순
const SORT_SPECS: Record<ShopSort, Record<string, SortOrder>> = {
    latest: { createdAt: -1 },
    price: { price: 1, createdAt: -1 },
    popular: { purchaseCount: -1, createdAt: -1 },
};

@Injectable()
export class ShopService {
    constructor(
        @InjectModel(ShopItem.name)
        private readonly shopItemModel: Model<ShopItemDocument>,
        @InjectModel(UserItem.name)
        private readonly userItemModel: Model<UserItemDocument>,
        @InjectConnection() private readonly connection: Connection,
        private readonly points: PointService,
    ) { }

    /** 판매 중인 아이템 목록. category가 없으면 전체 */
    async listItems(category?: ShopCategory, sort: ShopSort = 'latest'): Promise<ShopItemView[]> {
        const filter = category ? { isActive: true, category } : { isActive: true };
        const docs = await this.shopItemModel.find(filter).sort(SORT_SPECS[sort]).lean<ShopItemLean[]>();
        return docs.map(toView);
    }

    /** 찜 토글. 없는(또는 판매 중지된) 아이템이면 undefined */
    async toggleWish(userId: string, itemId: string): Promise<{ isWished: boolean } | undefined> {
        const item = await this.findActiveItem(itemId);
        if (!item) return undefined;

        const row = await this.ensureUserItem(new Types.ObjectId(userId), item);
        const next = !row.isWished;
        // 읽은 값(row.isWished)이 그대로일 때만 바꾼다
        // → 거의 동시에 두 번 눌러도 한 번만 뒤집힘
        await this.userItemModel.updateOne(
            { _id: row._id, isWished: row.isWished },
            { $set: { isWished: next } },
        );
        return { isWished: next };
    }

    /** 내 아이템 목록 (보유·찜·장착 상태). 최근에 생긴 것부터 */
    async listMyItems(userId: string): Promise<UserItemView[]> {
        const docs = await this.userItemModel
            .find({ userId: new Types.ObjectId(userId) })
            .sort({ createdAt: -1 })
            .lean<UserItemLean[]>();
        return docs.map(toUserItemView);
    }

    /** 장착. 보유하지 않은 아이템이면 false */
    async equip(userId: string, itemId: string): Promise<boolean> {
        // 기본 아바타 장착 = 장착 중인 아바타를 모두 해제하는 것 (테마는 그대로)
        if (itemId === BASE_AVATAR_ID) {
            await this.userItemModel.updateMany(
                { userId: new Types.ObjectId(userId), itemCategory: 'avatar', isEquipped: true },
                { $set: { isEquipped: false } },
            );
            return true;
        }

        if (!isValidObjectId(itemId)) return false;
        const owner = new Types.ObjectId(userId);
        const itemObjectId = new Types.ObjectId(itemId);

        // "다른 것 해제"와 "이것 장착"을 한 묶음(트랜잭션)으로: 거의 동시에 눌러도 장착이 둘이 되거나 하나도 없게 되지 않는다
        return this.connection.transaction(async (session) => {
            const target = await this.userItemModel
                .findOne({ userId: owner, itemId: itemObjectId, isOwned: true }, null, { session })
                .lean<UserItemLean>();
            if (!target) return false;

            // 같은 종류(아바타끼리 · 테마끼리)에서 지금 장착 중인 다른 아이템을 해제
            await this.userItemModel.updateMany(
                { userId: owner, itemCategory: target.itemCategory, isEquipped: true, _id: { $ne: target._id } },
                { $set: { isEquipped: false } },
                { session },
            );
            await this.userItemModel.updateOne({ _id: target._id }, { $set: { isEquipped: true } }, { session });
            return true;
        });
    }

    /** 구매. 없는(또는 판매 중이 아닌) 아이템이면 undefined, 이미 보유면 409, 포인트 부족이면 400 */
    async purchase(userId: string, itemId: string): Promise<{ balance: number } | undefined> {
        const item = await this.findActiveItem(itemId);
        if (!item) return undefined;

        const owner = new Types.ObjectId(userId);

        // 아래 쓰기들을 한 묶음(트랜잭션)으로 처리: 하나라도 실패하면 전부 없던 일이 된다
        return this.connection.transaction(async (session) => {
            // 값은 트랜잭션 안에서 다시 읽는다: 앞에서 읽은 뒤 가격이 바뀌었거나 판매가 중지됐을 수 있다
            const current = await this.shopItemModel
                .findOne({ _id: item._id, isActive: true }, null, { session })
                .lean<ShopItemLean>();
            if (!current) return undefined;

            const alreadyOwned = await this.userItemModel
                .exists({ userId: owner, itemId: current._id, isOwned: true })
                .session(session);
            if (alreadyOwned) {
                throw new ConflictException({
                    code: 'ITEM_ALREADY_OWNED',
                    message: '이미 보유한 아이템입니다.',
                });
            }

            // 포인트 차감 + 장부 기록 (모자라면 여기서 400)
            const balance = await this.points.spend(userId, current.price, 'purchase', `${current.name} 구매`, session);

            // 보유 처리: 찜 행이 있으면 갱신하고, 없으면 새로 만든다
            await this.userItemModel.updateOne(
                { userId: owner, itemId: current._id },
                {
                    $set: { itemCategory: current.category, isOwned: true, acquiredAt: new Date() },
                    $setOnInsert: { isWished: false, isEquipped: false },
                },
                { upsert: true, session },
            );

            // 인기순 기준: 구매 수 +1
            await this.shopItemModel.updateOne({ _id: current._id }, { $inc: { purchaseCount: 1 } }, { session });
            return { balance };
        });
    }

    private async findActiveItem(id: string): Promise<ShopItemLean | null> {
        // ObjectId 모양이 아닌 ID는 DB에 묻지 않고 바로 "없음" (그냥 물으면 500 에러)
        if (!isValidObjectId(id)) return null;
        const doc = await this.shopItemModel.findOne({ _id: id, isActive: true }).lean<ShopItemLean>();
        return doc;
    }

    /** 이 사람과 이 아이템의 user_items 행을 찾고, 없으면 만든다 */
    private async ensureUserItem(userId: Types.ObjectId, item: ShopItemLean): Promise<UserItemLean> {
        const filter = { userId, itemId: item._id };
        try {
            const row = await this.userItemModel
                .findOneAndUpdate(
                    filter,
                    {
                        $setOnInsert: {
                            itemCategory: item.category,
                            isOwned: false,
                            isWished: false,
                            isEquipped: false,
                            acquiredAt: null,
                        },
                    },
                    { upsert: true, returnDocument: 'after' },
                )
                .lean<UserItemLean>();
            if (row) return row;
        } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
        }
        // 동시에 두 요청이 행을 만들려 해서 한쪽이 막힌 경우: 먼저 만들어진 행을 읽는다
        const existing = await this.userItemModel.findOne(filter).lean<UserItemLean>();
        if (!existing) throw new Error('user_items 행을 만들지 못했습니다.');
        return existing;
    }
}

/** DB 문서 → 앱 응답 모양 (필요한 필드만, _id는 글자로) */
function toView(doc: ShopItemLean): ShopItemView {
    return {
        _id: doc._id.toString(),
        category: doc.category,
        name: doc.name,
        description: doc.description,
        price: doc.price,
        avatarStyle: doc.avatarStyle,
        thumbnailUrl: doc.thumbnailUrl,
        assetUrl: doc.assetUrl,
        purchaseCount: doc.purchaseCount,
        isActive: doc.isActive,
        isDefault: doc.isDefault,
        badge: doc.badge,
    };
}

/** MongoDB 중복 키 오류(unique 인덱스 위반)인지 */
function isDuplicateKeyError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

/** DB 문서 → 앱 응답 모양 (ID는 글자로, 날짜는 ISO 문자열로) */
function toUserItemView(doc: UserItemLean): UserItemView {
    return {
        _id: doc._id.toString(),
        itemId: doc.itemId.toString(),
        itemCategory: doc.itemCategory,
        isOwned: doc.isOwned,
        isWished: doc.isWished,
        isEquipped: doc.isEquipped,
        acquiredAt: doc.acquiredAt ? doc.acquiredAt.toISOString() : null,
    };
}