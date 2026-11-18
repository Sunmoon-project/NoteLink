import { Controller, Get, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { StudyService, type SubjectView } from './study.service.js';

@Controller('subjects')
@UseGuards(JwtAuthGuard)
export class SubjectsController {
    constructor(private readonly study: StudyService) { }

    /** GET /api/v1/subjects */
    @Get()
    async list(): Promise<{ data: SubjectView[] }> {
        return { data: await this.study.listSubjects() };
    }
}
