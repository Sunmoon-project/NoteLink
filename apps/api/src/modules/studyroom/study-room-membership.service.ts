import { Injectable } from '@nestjs/common';

import { StudyChatGateway } from './study-chat.gateway.js';
import { StudyLiveService } from './study-live.service.js';
import { StudyRoomsService } from './study-rooms.service.js';

/**
 * 스터디룸에서 나가는 일을 한 곳에 모은다: 방 멤버 상태(leaveRoom) · 소켓 구독(evict) · 남은 참가자에게 알림(notifyMembersChanged) ·
 * LiveKit 연결 종료(disconnect). 컨트롤러 leave() 와 회원 탈퇴(UsersService)가 같이 쓴다.
 *
 * StudyRoomsService 가 이 서비스를 받으면 서로 받는 순환이 되므로, 입장 · 생성 뒤 탈퇴와 겹쳤을 때 참여를 되돌리는 일은
 * 생성자에서 StudyRoomsService.rollbackMembership 에 넣는다(quizSets.afterReview 와 같은 방식). 되돌리기는 탈퇴 때문에 하는
 * 일이라 탈퇴용 순서(leaveRoomForWithdrawal)를 쓴다
 */
@Injectable()
export class StudyRoomMembershipService {
  constructor(
    private readonly rooms: StudyRoomsService,
    private readonly gateway: StudyChatGateway,
    private readonly live: StudyLiveService,
  ) {
    rooms.rollbackMembership = (userId, roomId) => this.leaveRoomForWithdrawal(userId, roomId);
  }

  /**
   * 방에서 나간다(컨트롤러 leave()). 순서는 나간 뒤에 연결을 끊는다: 연결을 먼저 끊으면 아직 멤버인 사이에
   * 같은 사용자가 소켓 구독 · LiveKit 토큰을 다시 받을 수 있다. 실패하면 같은 요청을 다시 보내면 된다
   * (leaveRoom 은 이미 나간 방이면 오류 없이 넘어가고, 연결 끊기는 다시 해도 같다)
   */
  async leave(userId: string, roomId: string): Promise<void> {
    await this.rooms.leaveRoom(userId, roomId);
    await this.gateway.evict(roomId, userId);

    // 남아 있는 참가자에게 목록이 변경됐다고 알림
    this.gateway.notifyMembersChanged(roomId);

    await this.live.disconnect(roomId, userId);
  }

  /**
   * 회원 탈퇴 중에 참여 중인 방마다 나간다. 방은 참여 중인 방 목록으로 찾으므로, 나가기를 먼저 마치고 연결 끊기가
   * 실패하면 다시 시도할 때 그 방이 목록에서 빠져 연결이 끊기지 않는다. 그래서 연결 끊기(둘 다 이미 연결이 없어도
   * 오류 없이 끝난다)를 먼저 하고, 나가기가 끝난 뒤에 알린다. 탈퇴는 이미 모든 로그인을 끊은 뒤라 그 사이에 다시 붙을 수 없다.
   * 실패하면 던진다: 탈퇴가 실패하고 다시 시도하면 남은 방부터 이어서 한다.
   * 다 처리한 뒤 목록을 한 번 더 읽어 그 사이에 새로 생긴 참여가 남았으면 같은 순서로 정리한다(한 번만 한다)
   */
  async leaveAllForWithdrawal(userId: string): Promise<void> {
    for (const room of await this.rooms.list(userId, 'mine')) {
      await this.leaveRoomForWithdrawal(userId, room._id);
    }
    for (const room of await this.rooms.list(userId, 'mine')) {
      await this.leaveRoomForWithdrawal(userId, room._id);
    }
  }

  /**
   * 방 하나를 탈퇴용 순서(소켓 구독 해제 → LiveKit 연결 종료 → 나가기 → 알림)로 처리한다. 탈퇴 일괄 처리와 입장 · 생성 뒤
   * 되돌리기가 같이 쓴다: 연결 끊기가 실패하면 멤버십이 남아 있어서, 탈퇴를 다시 시도할 때 이 방이 목록에 다시 나온다
   */
  private async leaveRoomForWithdrawal(userId: string, roomId: string): Promise<void> {
    await this.gateway.evict(roomId, userId);
    await this.live.disconnect(roomId, userId);
    await this.rooms.leaveRoom(userId, roomId);
    this.gateway.notifyMembersChanged(roomId);
  }
}
