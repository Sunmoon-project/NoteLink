import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module.js';
import { Friendship, FriendshipSchema } from '../social/schemas/friendship.schema.js';
import { Timetable, TimetableSchema } from '../calendar/schemas/timetable.schema.js';
import { TimetableShare, TimetableShareSchema } from '../calendar/schemas/timetable-share.schema.js';
import { TimetableController } from './timetable.controller.js';
import { TimetableService } from './timetable.service.js';
import { User, UserSchema } from '../auth/schemas/user.schema.js';
import { NotificationModule } from '../notification/notification.module.js';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: Timetable.name, schema: TimetableSchema },
            { name: TimetableShare.name, schema: TimetableShareSchema },
            { name: Friendship.name, schema: FriendshipSchema }, // 공유할 친구가 진짜 친구인지 확인한다 (읽기만)
            { name: User.name, schema: UserSchema }, // 공유 알림 문구의 내 닉네임 (읽기만)
        ]),
        AuthModule, // 로그인 확인(JwtAuthGuard)에 필요한 도구를 가져온다
        NotificationModule, // 시간표 공유 알림(#560)
    ],
    controllers: [TimetableController],
    providers: [TimetableService],
    exports: [TimetableService], // 친구 삭제(FR-15-06) 때 공유 정리에 쓸 수 있게 열어 둔다
})
export class TimetableModule { }
