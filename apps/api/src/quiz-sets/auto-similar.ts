/**
 * 퀴즈를 끝낸 뒤 자동 오답 복습(similar_quiz, LLM으로 비슷한 문제 만들기)을 넣을지(#625). 환경 설정
 * AUTO_SIMILAR_ON_FINISH가 'true'일 때만 켠다(기본 꺼짐: 사용자가 요청하지 않은 LLM 호출을 없앰).
 * - 꺼짐: 끝내기 뒤 · 이어 받기(catchUp)가 작업을 넣지 않는다. 복습 일정(srs)은 퀴즈를 끝낼 때 API가 LLM 없이
 *   옮기고(QuizAttemptsService.finish), 결과 화면의 유사 퀴즈(세트로 만들기)는 복습 상태를 옮기지 않는 고르기 모드로 만든다
 * - 켜짐: 예전과 같다(되돌리기용). 앱 설정에 AUTO_SIMILAR_ON_FINISH=true를 넣고 다시 시작하면 된다
 * 부를 때마다 읽는다(설정은 서버를 다시 시작해야 바뀌지만, 시험에서 바꿔 끼우기 쉽게)
 */
export function autoSimilarOnFinish(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AUTO_SIMILAR_ON_FINISH']?.trim().toLowerCase() === 'true';
}
