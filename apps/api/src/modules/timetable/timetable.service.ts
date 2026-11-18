import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { Friendship } from '../social/schemas/friendship.schema.js';
import type { AddClassDto, ShareTimetableDto } from './dto/timetable.dto.js';
import { Timetable, type TimetableClass } from '../calendar/schemas/timetable.schema.js';
import { TimetableShare, type ShareMode } from '../calendar/schemas/timetable-share.schema.js';

/** 앱에 내려주는 수업 (공유 계약 TimetableClass) */
export interface ClassView {
    _id: string;
    subjectName: string;
    days: number[];
    startTime: string;
    endTime: string;
    location: string;
    color: string;
    source: string;
}

/** 앱에 내려주는 시간표 (공유 계약 Timetable) */
export interface TimetableView {
    _id: string;
    updatedAt: string;
    classes: ClassView[];
}

/** 앱에 내려주는 공유 기록 (공유 계약 TimetableShare) */
export interface ShareView {
    _id: string;
    friendId: string;
    mode: ShareMode;
    sharedAt: string;
}

type TimetableLean = Timetable & { _id: Types.ObjectId; updatedAt: Date };
type ShareLean = TimetableShare & { _id: Types.ObjectId };

const NOT_FOUND = { code: 'NOT_FOUND', message: '존재하지 않는 수업입니다.' };

@Injectable()
export class TimetableService {
    constructor(
        @InjectModel(Timetable.name) private readonly timetableModel: Model<Timetable>,
        @InjectModel(TimetableShare.name) private readonly shareModel: Model<TimetableShare>,
        @InjectModel(Friendship.name) private readonly friendshipModel: Model<Friendship>,
    ) { }

    /** 내 시간표. 아직 수업을 하나도 안 넣었으면 빈 시간표를 돌려준다 (이때는 저장하지 않는다) */
    async get(userId: string, now = new Date()): Promise<TimetableView> {
        const doc = await this.timetableModel.findOne({ userId: new Types.ObjectId(userId) }).lean<TimetableLean | null>();
        if (!doc) return { _id: `tt-${userId}`, updatedAt: now.toISOString(), classes: [] };
        return { _id: doc._id.toString(), updatedAt: doc.updatedAt.toISOString(), classes: doc.classes.map(toClassView) };
    }

    /** 수업을 추가한다. 시간표가 없으면 이때 만든다 */
    async addClass(userId: string, dto: AddClassDto): Promise<ClassView> {
        if (dto.endTime <= dto.startTime) {
            throw new BadRequestException({ code: 'VALIDATION_ERROR', message: '끝나는 시간은 시작 시간보다 늦어야 합니다.' });
        }
        const cls: TimetableClass = {
            _id: new Types.ObjectId(),
            subjectName: dto.subjectName,
            days: [...dto.days].sort((a, b) => a - b),
            startTime: dto.startTime,
            endTime: dto.endTime,
            location: dto.location ?? '',
            color: dto.color,
            source: 'manual',
        };
        await this.timetableModel.updateOne({ userId: new Types.ObjectId(userId) }, { $push: { classes: cls } }, { upsert: true });
        return toClassView(cls);
    }

    /** 수업을 지운다. 없거나 남의 것이면 404 */
    async removeClass(userId: string, classId: string): Promise<void> {
        if (!Types.ObjectId.isValid(classId)) throw new NotFoundException(NOT_FOUND);
        const id = new Types.ObjectId(classId);
        const done = await this.timetableModel.updateOne(
            { userId: new Types.ObjectId(userId), 'classes._id': id },
            { $pull: { classes: { _id: id } } },
        );
        if (done.matchedCount === 0) throw new NotFoundException(NOT_FOUND);
    }

    /**
     * 친구들에게 시간표를 공유한다. 이미 공유 중이면 방식만 바꾼다. 친구가 아닌 사람이 섞여 있으면 하나도 공유하지 않는다.
     * 공유하는 사이에 누군가와 친구가 끊기면 「공유한 뒤 끊긴 것」으로 처리한다: 끊긴 사람의 공유만 지우고 나머지는 남긴다
     * (두 요청을 차례로 한 결과와 같다). 되돌리지 않으므로, 겹친 다른 공유 요청의 결과를 잃거나 공개 범위가 넓어지지 않는다
     */
    async share(userId: string, dto: ShareTimetableDto, now = new Date()): Promise<void> {
        const owner = new Types.ObjectId(userId);
        // 대문자 등 표기가 달라도 같은 ID로 보도록 소문자 표준형으로 바꾸고 중복을 없앤다
        const requested = [...new Set(dto.friendIds.map((id) => new Types.ObjectId(id).toHexString()))];
        const friends = await this.friendLinks(owner, requested);
        const strangers = requested.filter((id) => !friends.has(id));
        if (strangers.length > 0) {
            throw new BadRequestException({ code: 'NOT_FRIEND', message: '친구가 아닌 사용자에게는 시간표를 공유할 수 없습니다.' });
        }
        // 이 관계(또는 관계 id가 없는 예전 공유)의 줄에만 쓴다. 다른 관계의 공유가 이미 있으면 — 이 요청이 늦게 쓰는 사이
        // 친구를 끊었다 다시 맺고 새로 공유했다 — 덮어쓰지 않고 건너뛴다(유일 인덱스가 중복 오류를 낸다). 예전 공유가 끊기며
        // 지워진 뒤 새 공유가 생긴 것과 같은 결과다
        try {
            await this.shareModel.bulkWrite(
                requested.map((friendId) => ({
                    updateOne: {
                        filter: { ownerId: owner, friendId: new Types.ObjectId(friendId), friendshipId: { $in: [friends.get(friendId)!, null] } },
                        // 어느 친구 관계에서 만든 공유인지 남긴다(끊기면 그 관계의 공유만 정리한다)
                        update: { $set: { mode: dto.mode, sharedAt: now, friendshipId: friends.get(friendId)! } },
                        upsert: true,
                    },
                })),
                { ordered: false },
            );
        } catch (error) {
            const skipped = duplicateKeyIndexes(error);
            if (!skipped) throw error;
            // 다른 관계의 공유와 부딪혔다. 그 관계가 이미 끊겼으면(아직 정리 전인 예전 공유) 이 요청의 공유로 바꿔 쓴다
            for (const i of skipped) {
                const friendId = requested[i]!;
                await this.replaceEndedShare(owner, new Types.ObjectId(friendId), friends.get(friendId)!, dto.mode, now);
            }
        }
        // 확인한 뒤 쓰는 사이에 친구를 끊었으면(FriendsService.remove는 관계 → 공유 순으로 지운다) 방금 쓴 공유가 남는다.
        // 다시 확인해서, 처음 확인한 친구 관계가 끊긴 사람의 공유를 지운다(끊기가 공유 뒤에 온 것과 같은 결과). 다시 확인이
        // 통과했다면 쓰기는 끊기보다 앞이라 끊기의 공유 정리가 지운다.
        // 그 관계(friendshipId)로 쓴 공유만 지운다: 그사이 다시 친구가 되어 새로 공유했다면 새 관계의 id라 지워지지 않는다
        const still = await this.friendLinks(owner, requested);
        const gone = requested.filter((id) => !still.get(id)?.equals(friends.get(id)!));
        if (gone.length > 0) {
            await this.shareModel.deleteMany({
                ownerId: owner,
                $or: gone.map((id) => ({ friendId: new Types.ObjectId(id), friendshipId: friends.get(id) })),
            });
        }
    }

    /**
     * 같은 쌍에 다른 관계로 만든 공유가 있을 때, 그 관계가 이미 끊겼으면 이 관계(mine)의 공유로 바꿔 쓴다.
     * 수락된 관계는 지워지기만 하고 되살아나지 않으므로, 끊긴 관계의 공유는 언제 바꿔 써도 된다. 그 관계가 살아 있으면
     * (이 요청이 늦었고 그사이 새로 친구가 되어 공유했다) 그대로 둔다. 바꿔 쓰는 사이 그 줄이 정리되면 다시 해 본다
     */
    private async replaceEndedShare(owner: Types.ObjectId, friendId: Types.ObjectId, mine: Types.ObjectId, mode: ShareMode, now: Date): Promise<void> {
        const set = { $set: { mode, sharedAt: now, friendshipId: mine } };
        for (let attempt = 0; attempt < 3; attempt++) {
            const row = await this.shareModel.findOne({ ownerId: owner, friendId }).select('friendshipId').lean<{ friendshipId?: Types.ObjectId | null }>();
            if (!row) {
                // 그사이 예전 줄이 정리됐다: 다시 같은 관계 조건으로 쓴다(또 부딪히면 다시 본다)
                try {
                    await this.shareModel.updateOne({ ownerId: owner, friendId, friendshipId: { $in: [mine, null] } }, set, { upsert: true });
                    return;
                } catch (error) {
                    if ((error as { code?: unknown } | null)?.code !== 11000) throw error;
                    continue;
                }
            }
            const other = row.friendshipId ?? null;
            if (other && !other.equals(mine) && (await this.friendshipModel.exists({ _id: other, status: 'accepted' }))) return;
            const done = await this.shareModel.updateOne({ ownerId: owner, friendId, friendshipId: other }, set);
            if (done.matchedCount === 1) return;
        }
    }

    /** 내가 시간표를 공유 중인 친구들 (공유한 순서) */
    async shares(userId: string): Promise<ShareView[]> {
        const docs = await this.shareModel
            .find({ ownerId: new Types.ObjectId(userId) })
            .sort({ sharedAt: 1 })
            .lean<ShareLean[]>();
        return docs.map((d) => ({ _id: d._id.toString(), friendId: d.friendId.toString(), mode: d.mode, sharedAt: d.sharedAt.toISOString() }));
    }

    /** 주어진 사용자 중 나와 수락된 친구 관계인 사람 → 그 친구 관계 문서 id */
    private async friendLinks(owner: Types.ObjectId, candidates: string[]): Promise<Map<string, Types.ObjectId>> {
        const ids = candidates.map((id) => new Types.ObjectId(id));
        const docs = await this.friendshipModel
            .find({
                status: 'accepted',
                $or: [
                    { userA: owner, userB: { $in: ids } },
                    { userB: owner, userA: { $in: ids } },
                ],
            })
            .lean<(Pick<Friendship, 'userA' | 'userB'> & { _id: Types.ObjectId })[]>();
        return new Map(docs.map((d) => [(d.userA.equals(owner) ? d.userB : d.userA).toString(), d._id]));
    }
}

/**
 * bulkWrite 오류가 모두 중복 키(11000)이면 실패한 쓰기의 순번들을, 아니면 null을 돌려준다
 * (다른 관계의 공유가 이미 있어 조건에 안 맞은 쓰기만 실패했는지)
 */
function duplicateKeyIndexes(error: unknown): number[] | null {
    const raw = (error as { writeErrors?: unknown } | null)?.writeErrors;
    const list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as { code?: unknown; index?: unknown }[];
    if (!list.length || !list.every((e) => e.code === 11000 && typeof e.index === 'number')) return null;
    return list.map((e) => e.index as number);
}

function toClassView(cls: TimetableClass): ClassView {
    return {
        _id: cls._id.toString(),
        subjectName: cls.subjectName,
        days: cls.days,
        startTime: cls.startTime,
        endTime: cls.endTime,
        location: cls.location ?? '', // develop 스키마는 location이 없거나 null일 수 있어 앱에는 항상 문자열로 준다
        color: cls.color,
        source: cls.source ?? 'manual', // 예전 형식으로 저장된 수업에는 source가 없을 수 있어 기본값을 채운다
    };
}
