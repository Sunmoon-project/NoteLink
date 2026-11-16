import { IsIn, IsMongoId } from 'class-validator';

import { SESSION_MODES, type SessionMode } from '../schemas/study-session.schema.js';

// POST /study-sessions { studyItemId, mode }
export class StartStudySessionDto {
    @IsMongoId()
    studyItemId!: string;

    @IsIn(SESSION_MODES)
    mode!: SessionMode;
}
