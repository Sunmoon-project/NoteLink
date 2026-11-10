import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../auth/schemas/user.schema.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
    imports: [
        AuthModule,
        MongooseModule.forFeature([{ name: User.name, schema: UserSchema}]),
    ],
    controllers: [UsersController],
    providers: [UsersService],
})
export class UsersModule {}
