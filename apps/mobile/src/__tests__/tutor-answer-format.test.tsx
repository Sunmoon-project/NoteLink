import { render, screen } from '@testing-library/react-native';
import { AnswerText, formatAnswer } from '../features/tutor/answer-text';

// 실기기 테스트: 아바타 선생님 답변이 한 문단으로 길게 와 읽기 힘들었다(실서버 답변 그대로)
const quizAnswer =
  "좋아요, 노트 내용으로 퀴즈를 만들어 볼게요. 1번, Next.js app router에서 기본 렌더링 전략은 무엇일까요? (정답: 정적 렌더링, 빌드 때 HTML을 미리 생성해요.) 2번, cookies()나 headers() 같은 동적 함수를 쓰면 라우트는 어떻게 렌더링될까요? (정답: 라우트 전체가 요청 시점의 동적 렌더링으로 바뀌어요.) 3번, 페이지를 강제로 동적 렌더링하려면 맨 위에 무엇을 쓸까요? (정답: export const dynamic = 'force-dynamic'). 하나씩 답해 보세요.";
const pointsAnswer =
  '노트 내용으로 보면 이런 부분이 시험에 나올 만해요. 첫째, 정적 렌더링은 app router의 기본 전략이에요. 둘째, cookies() 같은 동적 함수를 쓰면 라우트 전체가 동적 렌더링으로 바뀐다는 점이에요. 셋째, generateStaticParams()로 동적 경로를 미리 만든다는 점이에요. 그 밖에 hydration의 의미도 챙겨 보세요.';

describe('선생님 답변 정리', () => {
  it('새 지침대로 온 답(빈 줄 문단 · 번호 · 글머리표)을 그대로 나눈다', () => {
    expect(
      formatAnswer(
        '정적 렌더링은 미리 만들어 둬요.\n\n1. **정적** 렌더링\n2. 동적 렌더링\n\n- 기억할 점\n이어서 퀴즈로 확인해 보세요.',
      ),
    ).toEqual([
      { kind: 'p', text: '정적 렌더링은 미리 만들어 둬요.' },
      { kind: 'ol', no: '1', text: '**정적** 렌더링' },
      { kind: 'ol', no: '2', text: '동적 렌더링' },
      { kind: 'ul', text: '기억할 점' },
      { kind: 'p', text: '이어서 퀴즈로 확인해 보세요.' },
    ]);
  });

  it('한 문단으로 온 퀴즈 답은 「1번 · 2번」에서 나눠 번호 목록으로 보인다', () => {
    const blocks = formatAnswer(quizAnswer);
    expect(blocks[0]).toEqual({ kind: 'p', text: '좋아요, 노트 내용으로 퀴즈를 만들어 볼게요.' });
    expect(blocks.filter((b) => b.kind === 'ol').map((b) => (b as { no: string }).no)).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(blocks[1]).toMatchObject({
      kind: 'ol',
      text: expect.stringMatching(/^Next\.js app router/),
    });
  });

  it('한 문단으로 온 「첫째 · 둘째 · 셋째」는 항목마다 문단으로 나눈다', () => {
    const blocks = formatAnswer(pointsAnswer);
    expect(blocks.map((b) => b.text.slice(0, 3))).toEqual([
      '노트 ',
      '첫째,',
      '둘째,',
      '셋째,',
      '그 밖',
    ]);
  });

  it('나열이 없는 긴 답은 두 문장씩 문단으로, 짧은 답은 그대로 둔다', () => {
    const long =
      "정적 렌더링은 '미리 만들어 둔 도시락'이라고 생각하면 쉬워요. 빌드할 때 HTML을 한 번 만들어 두고 모든 사용자에게 똑같이 나눠 주니까 아주 빠르죠. 동적 렌더링은 '주문을 받고 만드는 요리'예요. cookies()나 headers()처럼 요청 때만 알 수 있는 정보를 쓰면 요청마다 새로 만들어요. 이어서 퀴즈로 확인해 보세요.";
    expect(formatAnswer(long).map((b) => b.kind)).toEqual(['p', 'p', 'p']);
    expect(formatAnswer('짧은 답이에요.')).toEqual([{ kind: 'p', text: '짧은 답이에요.' }]);
  });

  it('**굵게**는 굵은 글자로, 닫히지 않은 **(나오는 중)는 기호만 지운다', async () => {
    await render(<AnswerText text={'핵심은 **hydration**이에요. 그리고 **미완'} />);
    expect(screen.getByText('hydration').props.className).toMatch(/font-bold/);
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });
});
