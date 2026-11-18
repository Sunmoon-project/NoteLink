import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { CalendarService, type DdayView, type TodoView } from './calendar.service.js';
import { CreateDdayDto, CreateTodoDto, ToggleTodoDto, TodosQueryDto } from './dto/todo.dto.js';

// 주소는 /api/v1/todos, /api/v1/ddays — 내 일정이라 전부 로그인 필요
@Controller()
@UseGuards(JwtAuthGuard)
export class CalendarController {
    constructor(private readonly calendar: CalendarService) { }

    /** GET /api/v1/todos?date=YYYY-MM-DD */
    @Get('todos')
    async todos(@Req() req: AuthenticatedRequest, @Query() query: TodosQueryDto): Promise<{ data: TodoView[] }> {
        return { data: await this.calendar.todos(requireUserId(req), query.date) };
    }

    /** POST /api/v1/todos */
    @Post('todos')
    @HttpCode(HttpStatus.CREATED)
    async addTodo(@Req() req: AuthenticatedRequest, @Body() body: CreateTodoDto): Promise<{ data: TodoView }> {
        return { data: await this.calendar.addTodo(requireUserId(req), body) };
    }

    /** PATCH /api/v1/todos/:id { done } */
    @Patch('todos/:id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async setDone(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: ToggleTodoDto): Promise<void> {
        await this.calendar.setDone(requireUserId(req), id, body.done);
    }

    /** GET /api/v1/ddays */
    @Get('ddays')
    async ddays(@Req() req: AuthenticatedRequest): Promise<{ data: DdayView[] }> {
        return { data: await this.calendar.ddays(requireUserId(req)) };
    }

    /** POST /api/v1/ddays { title, date } */
    @Post('ddays')
    @HttpCode(HttpStatus.CREATED)
    async addDday(@Req() req: AuthenticatedRequest, @Body() body: CreateDdayDto): Promise<{ data: DdayView }> {
        return { data: await this.calendar.addDday(requireUserId(req), body) };
    }
}
