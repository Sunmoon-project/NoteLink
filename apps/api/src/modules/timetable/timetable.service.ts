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

    /** 친구들에게 시간표를 공유한다. 이미 공유 중이면 방식만 바꾼다. 친구가 아닌 사람이 섞여 있으면 하나도 공유하지 않는다 */
    async share(userId: string, dto: ShareTimetableDto, now = new Date()): Promise<void> {
        const owner = new Types.ObjectId(userId);
        // 대문자 등 표기가 달라도 같은 ID로 보도록 소문자 표준형으로 바꾸고 중복을 없앤다
        const requested = [...new Set(dto.friendIds.map((id) => new Types.ObjectId(id).toHexString()))];
        const friends = await this.friendIds(owner, requested);
        const strangers = requested.filter((id) => !friends.has(id));
        if (strangers.length > 0) {
            throw new BadRequestException({ code: 'NOT_FRIEND', message: '친구가 아닌 사용자에게는 시간표를 공유할 수 없습니다.' });
        }
        const ids = requested.map((id) => new Types.ObjectId(id));
        // 실패하면 되돌리려고 쓰기 전 상태를 기억한다
        const before = await this.shareModel.find({ ownerId: owner, friendId: { $in: ids } }).lean<ShareLean[]>();
        await this.shareModel.bulkWrite(
            ids.map((friendId) => ({
                updateOne: {
                    filter: { ownerId: owner, friendId },
                    update: { $set: { mode: dto.mode, sharedAt: now } },
                    upsert: true,
                },
            })),
        );
        // 확인한 뒤 쓰는 사이에 친구를 끊었으면(FriendsService.remove는 관계 → 공유 순으로 지운다) 방금 쓴 공유가 남는다.
        // 다시 확인해서, 한 명이라도 끊겼으면 이 요청 전체를 되돌린다("하나라도 친구가 아니면 하나도 공유하지 않는다").
        // 다시 확인이 통과했다면 쓰기는 끊기보다 앞이라 끊기의 공유 정리가 지운다
        const still = await this.friendIds(owner, requested);
        const gone = requested.filter((id) => !still.has(id));
        if (gone.length > 0) {
            await this.undoShare(owner, ids, gone, before, now);
            throw new BadRequestException({ code: 'NOT_FRIEND', message: '친구가 아닌 사용자에게는 시간표를 공유할 수 없습니다.' });
        }
    }

    /**
     * share()가 쓴 것을 되돌린다. 끊긴 상대의 공유는 지우고, 나머지는 쓰기 전으로 돌린다(없던 공유는 지우고, 있던 공유는
     * 예전 방식 · 시각으로). 그사이 다른 요청이 새로 쓴 공유(sharedAt이 now가 아님)는 건드리지 않는다
     */
    private async undoShare(owner: Types.ObjectId, ids: Types.ObjectId[], gone: string[], before: ShareLean[], now: Date): Promise<void> {
        const previous = new Map(before.map((d) => [d.friendId.toString(), d]));
        await this.shareModel.bulkWrite(
            ids.map((friendId) => {
                const prev = previous.get(friendId.toString());
                const ours = { ownerId: owner, friendId, sharedAt: now };
                return gone.includes(friendId.toString()) || !prev
                    ? { deleteOne: { filter: gone.includes(friendId.toString()) ? { ownerId: owner, friendId } : ours } }
                    : { updateOne: { filter: ours, update: { $set: { mode: prev.mode, sharedAt: prev.sharedAt } } } };
            }),
        );
    }

    /** 내가 시간표를 공유 중인 친구들 (공유한 순서) */
    async shares(userId: string): Promise<ShareView[]> {
        const docs = await this.shareModel
            .find({ ownerId: new Types.ObjectId(userId) })
            .sort({ sharedAt: 1 })
            .lean<ShareLean[]>();
        return docs.map((d) => ({ _id: d._id.toString(), friendId: d.friendId.toString(), mode: d.mode, sharedAt: d.sharedAt.toISOString() }));
    }

    /** 주어진 사용자 중 나와 수락된 친구 관계인 사람의 id */
    private async friendIds(owner: Types.ObjectId, candidates: string[]): Promise<Set<string>> {
        const ids = candidates.map((id) => new Types.ObjectId(id));
        const docs = await this.friendshipModel
            .find({
                status: 'accepted',
                $or: [
                    { userA: owner, userB: { $in: ids } },
                    { userB: owner, userA: { $in: ids } },
                ],
            })
            .lean<Pick<Friendship, 'userA' | 'userB'>[]>();
        return new Set(docs.map((d) => (d.userA.equals(owner) ? d.userB : d.userA).toString()));
    }
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
