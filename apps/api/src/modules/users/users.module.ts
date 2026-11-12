import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../auth/schemas/user.schema.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProgressModule } from '../progress/progress.module.js';

@Module({
    imports: [
        AuthModule,
        ProgressModule, // 프로필의 연속 학습일(streakDays)
        MongooseModule.forFeature([{ name: User.name, schema: UserSchema}]),
    ],
    controllers: [UsersController],
    providers: [UsersService],
})
export class UsersModule {}
