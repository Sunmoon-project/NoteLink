"""테스트용 가짜 LLM. 호출 이름(name)마다 준비한 답을 차례로 돌려줍니다."""

import re
from collections.abc import Callable
from dataclasses import dataclass, field

from app.clients.llm import JsonObject, LlmError

type Answer = JsonObject | LlmError
# 답 목록(차례로 꺼냄), 또는 user 글을 보고 답하는 함수(부를 때마다)
type Answers = list[Answer] | Callable[[str], Answer]


@dataclass
class Call:
    model: str
    system: str
    user: str
    schema: JsonObject
    name: str


@dataclass
class FakeLlm:
    # 이름별 답. LlmError를 넣으면 그 차례에 예외를 던짐
    answers: dict[str, Answers] = field(default_factory=dict)
    calls: list[Call] = field(default_factory=list)
    backgrounded: bool = False  # background()로 받아 갔는지(SchoolLlm.background, #138)

    def background(self) -> "FakeLlm":
        self.backgrounded = True
        return self

    def call(
        self,
        model: str,
        system: str,
        user: str,
        schema: JsonObject,
        name: str,
        *,
        max_tokens: int = 1500,
        temperature: float = 0.0,
    ) -> JsonObject:
        self.calls.append(Call(model, system, user, schema, name))
        queue = self.answers.get(name)
        if callable(queue):
            a = queue(user)
        elif queue:
            a = queue.pop(0)
        else:
            raise AssertionError(f"준비하지 않은 LLM 호출: {name}")
        if isinstance(a, LlmError):
            raise a
        return a

    def named(self, name: str) -> list[Call]:
        return [c for c in self.calls if c.name == name]


def fits(*words: str) -> Callable[[str], JsonObject]:
    """묶은 '정답 둘' 검사(Naturals)의 가짜 판정: 후보 줄('1. 보기') 중 words에 든 보기만 true.

    정답을 넣으면 정답도 맞다고 봄(정답 판정이 같은 호출에 들어 있음).
    """

    def judge(user: str) -> JsonObject:
        return {"natural": [o in words for o in re.findall(r"^\d+\. (.*)$", user, re.M)]}

    return judge
