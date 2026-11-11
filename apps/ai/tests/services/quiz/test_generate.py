import copy
import re
import threading
import time
import types
from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from datetime import date, timedelta
from typing import Any

import pytest

from app.clients.llm import JsonObject, LlmError, LlmRejectedError, LlmSetupError
from app.core.config import settings
from app.services.quiz import generate, srs
from app.services.quiz.generate import Chunk, PageInfo
from app.services.quiz.review import InputError, seoul_midnight

PAGE1 = """Ⅰ. 근족충류
1. 이질 아메바
- 영양형: 위족으로 운동하고 적혈구를 먹는다
- 포낭형: 4핵, 인체 감염형
2. 대장 아메바
- 포낭형: 8핵, 비병원성"""
PAGE2 = """Ⅱ. 편모충류
1. 람블편모충
- 영양형: 서양배 모양, 흡착원판
- 포낭형: 타원형, 4핵
2. 질편모충
- 성 접촉으로 감염된다"""
REAL_LEVEL_MIX = generate.levels.level_mix
REAL_ORDER_TYPES = generate.levels.order_types
NAMES = ["이질 아메바", "대장 아메바", "람블편모충", "질편모충"]


@pytest.fixture(autouse=True)
def one_slot_at_a_time(monkeypatch: pytest.MonkeyPatch) -> None:
    """가짜 LLM이 차례로 답하므로 자리를 하나씩, 여분 자리 없이(동시 실행 시험은 따로 바꿈).

    판도 하나만: 모자란 자리를 다시 돌리는 것은 그 시험에서만 켬(fill_rounds).
    """
    monkeypatch.setattr(generate, "WORKERS", 1)
    monkeypatch.setattr(generate, "EXTRA", 0)
    monkeypatch.setattr(generate, "MAX_ROUNDS", 1)


@pytest.fixture(autouse=True)
def one_level(monkeypatch: pytest.MonkeyPatch) -> None:
    """난이도 비율(#268)을 끄고 #268 전 유형 순서로(쪽 유형 목록을 turn만큼 돌림): 이 파일의 시험은
    대부분 정의 모양 초안을 차례로 내므로. 난이도 비율 · 유형 고르기는 「난이도 비율」 시험이 이
    설정을 풀고 봄(mixed_levels)."""

    def rotate(types: list[str], want: str, lv: object, turn: int) -> list[str]:
        k = turn % len(types)
        return types[k:] + types[:k]

    monkeypatch.setattr(generate.levels, "level_mix", lambda n, usable, stats: {"하": n})
    monkeypatch.setattr(generate.levels, "order_types", rotate)


@pytest.fixture
def mixed_levels(monkeypatch: pytest.MonkeyPatch) -> None:
    """one_level을 풀고 실제 난이도 비율 · 유형 고르기로."""
    monkeypatch.setattr(generate.levels, "level_mix", REAL_LEVEL_MIX)
    monkeypatch.setattr(generate.levels, "order_types", REAL_ORDER_TYPES)


@pytest.fixture(autouse=True)
def keep_combo_order(monkeypatch: pytest.MonkeyPatch) -> None:
    """조합형 문장 순서를 섞지 않음: 가짜 검사 모델이 요청한 묶음을 정답으로 알고 풂(섞기는
    test_combo가 봄)."""
    monkeypatch.setattr(generate.combo, "order_for", lambda: [0, 1, 2])


@pytest.fixture
def fill_rounds(monkeypatch: pytest.MonkeyPatch) -> None:
    """모자란 자리를 다시 돌림(#247). 판은 3개까지, 시험의 짧은 상한에서도 새 판을 띄우게."""
    monkeypatch.setattr(generate, "MAX_ROUNDS", 3)
    monkeypatch.setattr(generate, "MIN_ROUND_SEC", 0.05)


@dataclass
class ScriptLlm:
    """이름마다 user 글을 보고 답하는 가짜 LLM. 답 대신 LlmError를 돌려주면 던집니다."""

    answers: dict[str, Callable[[str], JsonObject | LlmError]]
    calls: list[tuple[str, str]] = field(default_factory=list)
    models: list[tuple[str, str]] = field(default_factory=list)  # (호출 이름, 모델)

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
        self.calls.append((name, user))
        self.models.append((name, model))
        if name not in self.answers:
            raise AssertionError(f"준비하지 않은 LLM 호출: {name}")
        a = self.answers[name](user)
        if isinstance(a, LlmError):
            raise a
        return a

    def named(self, name: str) -> list[str]:
        return [u for n, u in self.calls if n == name]


def draft(answer: str, passage: str, concept: str | None = None, **more: Any) -> JsonObject:
    others = ["이질 아메바", "대장 아메바", "람블편모충", "질편모충", "말라리아"]
    options = [answer, *[o for o in others if o != answer][:4]]
    return {
        "question": {
            "stem": "다음 설명에 해당하는 원충은?",
            "passage": passage,
            "options": options,
            "answer": answer,
            "explanation": "노트에 적힌 특징입니다.",
            "difficulty": "보통",
            "concept": concept or answer,
            **more,
        }
    }


GOOD = {
    "이질 아메바": draft("이질 아메바", "위족으로 운동하고 적혈구를 먹으며 포낭형은 4핵이다"),
    "람블편모충": draft("람블편모충", "서양배 모양이고 흡착원판이 있으며 포낭형은 타원형이다"),
    "질편모충": draft("질편모충", "성 접촉으로 감염되는 편모충으로 노트에 적힌 원충이다"),
    "대장 아메바": draft("대장 아메바", "포낭형의 핵이 8개이고 병을 일으키지 않는 원충이다"),
}


def checker(answer_of: Callable[[str], str | None]) -> Callable[[str], JsonObject]:
    """검사 모델: 보기 줄(A. …) 중 정답 글이 있는 자리를 고름."""

    def check(user: str) -> JsonObject:
        want = answer_of(user)
        for m in re.finditer(r"^([A-E])\. (.+)$", user, re.M):
            if m.group(2) == want:
                return {"answer": m.group(1), "only_one": True, "supported": True}
        return {"answer": "없음", "only_one": False, "supported": False}

    return check


def candidates(user: str) -> list[str]:
    """묶은 '정답 둘' 검사(Naturals)의 후보 줄('1. 보기')."""
    return re.findall(r"^\d+\. (.*)$", user, re.M)


def quiz_from(queue: list[JsonObject | LlmError]) -> Callable[[str], JsonObject | LlmError]:
    def answer(user: str) -> JsonObject | LlmError:
        if not queue:
            raise AssertionError("초안이 모자람")
        return queue.pop(0)

    return answer


def happy(
    drafts: Sequence[JsonObject | LlmError], natural_fn: Callable[[str], JsonObject] | None = None
) -> ScriptLlm:
    made: list[str] = []
    queue = list(drafts)

    def quiz(user: str) -> JsonObject | LlmError:
        r = quiz_from(queue)(user)
        if not isinstance(r, LlmError):
            made.append(r["question"]["answer"])
        return r

    def nat(user: str) -> JsonObject:
        # 묶은 판정: 정답 보기는 true(지식 검사), 오답 보기는 false
        return {"natural": [bool(made) and o == made[-1] for o in candidates(user)]}

    return ScriptLlm(
        {
            "Quiz": quiz,
            "Naturals": natural_fn or nat,
            "Check": checker(lambda u: made[-1] if made else None),
            # 안정적 모드의 생성 모델 2차 풀기(#274): 검사 모델과 같은 답
            generate.RECHECK: checker(lambda u: made[-1] if made else None),
        }
    )


def job(**more: Any) -> JsonObject:
    return {
        "day": "2026-11-04",
        "size": 2,
        "material": {
            "id": "m1",
            "title": "기생충 1 원충류",
            "pages": [{"pageNo": 1, "ocrText": PAGE1}, {"pageNo": 2, "ocrText": PAGE2}],
            "concepts": NAMES,
        },
        "sets": [],
        "attempts": [],
        "notes": {},
        **more,
    }


def run(llm: ScriptLlm, inp: JsonObject) -> tuple[JsonObject, list[tuple[int, str | None]]]:
    steps: list[tuple[int, str | None]] = []
    result = generate.run(llm, inp, lambda v, step=None: steps.append((v, step)))
    return result, steps


# ---------- 쪽마다 문제 수 · 과목 · 유형 (코드) ----------


def pages_of(n: int, lines: int = 5) -> dict[int, str]:
    return {p: "\n".join(f"{p}쪽 {i}줄" for i in range(lines)) for p in range(1, n + 1)}


def test_a_new_note_is_shared_out_evenly_and_spread_over_pages() -> None:
    weight, share, plain = generate.allocate(pages_of(21), defaultdict(PageInfo), 10)
    assert set(weight.values()) == {1.0}
    assert sum(share.values()) == 10 and max(share.values()) == 1
    assert sorted(p for p, k in share.items() if k) != list(range(1, 11))  # 앞 10쪽에 몰리지 않음
    assert plain == {p: (1 if p <= 10 else 0) for p in range(1, 22)}


def test_pages_with_unlearned_wrong_answers_get_more_and_learned_ones_still_one() -> None:
    per = defaultdict(PageInfo)
    per[2] = PageInfo(wrong=2, weak=["람블편모충"])
    per[3] = PageInfo(mastered=3, done=["a", "b", "c"])
    weight, share, _ = generate.allocate(pages_of(3), per, 10)
    assert weight == {1: 1.0, 2: 4.0, 3: 0.3}
    assert share[2] > share[1] and share[3] == 1  # 다 익힌 쪽도 한 문제로 다시 확인
    assert sum(share.values()) == 10


def test_a_page_with_wrong_answers_does_not_give_its_question_to_a_learned_page() -> None:
    # 쪽이 문제 수보다 많아 몫이 모두 0 · 1이면 쪽 순서로 첫 쪽(틀린 답이 있는 1쪽)에서 뺐음
    # (/code-review #94)
    per = defaultdict(PageInfo)
    per[1] = PageInfo(wrong=1, weak=["이질 아메바"])
    per[12] = PageInfo(mastered=1, done=["말라리아"])
    _, share, _ = generate.allocate(pages_of(12), per, 6)
    assert share[1] == 1 and share[12] == 1 and sum(share.values()) == 6
    # 틀린 답과 다 익힌 개념이 함께 있어 한 문제를 받은 쪽 중 가중치가 가장 작은 쪽(0.4)도 빼지
    # 않음: 7쪽 · 6문제면 1쪽이 반올림으로 한 문제를 받고 몫이 모두 0 · 1
    per = defaultdict(PageInfo)
    per[1] = PageInfo(wrong=1, mastered=3, weak=["이질 아메바"], done=["a", "b", "c"])
    per[7] = PageInfo(mastered=1, done=["말라리아"])
    weight, share, _ = generate.allocate(pages_of(7), per, 6)
    assert weight[1] == pytest.approx(0.4) and max(share.values()) == 1
    assert share[1] == 1 and share[7] == 1 and sum(share.values()) == 6


def test_a_learned_page_is_not_checked_again_at_the_cost_of_a_page_still_wrong() -> None:
    # 한 문제씩 받은 쪽이 모두 틀린 답이 있으면 다시 확인을 건너뜀(/code-review #94)
    per = defaultdict(PageInfo)
    for p in range(1, 7):
        per[p] = PageInfo(wrong=1, weak=[f"c{p}"])
    per[7] = PageInfo(mastered=1, done=["말라리아"])
    _, share, _ = generate.allocate(pages_of(7), per, 6)
    assert share == {1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 0}
    # 다 익힌 쪽끼리 한 문제를 주고받지 않음: 0문제인 쪽은 그대로 0, 나머지 여섯 쪽은 한 문제씩
    per = defaultdict(PageInfo, {p: PageInfo(mastered=1, done=[f"c{p}"]) for p in range(1, 8)})
    _, share, _ = generate.allocate(pages_of(7), per, 6)
    plain = generate.allocate(pages_of(7), defaultdict(PageInfo), 6)[1]
    zero = [p for p in plain if plain[p] == 0]
    assert len(zero) == 1 and share == plain  # 0문제인 쪽은 그대로 0(다시 확인을 건너뜀)


def test_short_pages_are_not_asked() -> None:
    pages = {1: pages_of(1)[1], 2: "짧은 쪽\n두 줄"}
    weight, share, _ = generate.allocate(pages, defaultdict(PageInfo), 4)
    assert list(weight) == [1] and share == {1: 4}
    assert generate.allocate({2: "한 줄"}, defaultdict(PageInfo), 4) == ({}, {}, {})


def test_subject_and_types() -> None:
    toeic = {1: "The man is holding a cup and the women are walking to the door of the shop. " * 3}
    assert generate.is_korean_subject({1: PAGE1, 2: PAGE2})
    assert generate.is_korean_subject({1: PAGE1 + " in a"})  # 영어 낱말이 적으면 비율은 우연
    assert not generate.is_korean_subject(toeic)
    photo = "(A) He is holding a cup\n(B) They are walking\n(C) She is typing\n(D) A cart is parked"
    assert generate.page_types(photo, False) == ["묘사", "어휘"]
    assert generate.page_types(PAGE1, True) == ["정의", "특징", "분류"]
    assert generate.page_types("Part 5\nrequest that he be", False) == ["빈칸", "어휘", "규칙"]


# ---------- 노트 조각 (코드) ----------


def chunk(order: int, text: str, page: int, title: str | None = None, **more: Any) -> Chunk:
    return Chunk(order, title, more.get("path", []), text, page, more.get("concept"))


def test_chunks_give_the_fixed_text_page_by_page() -> None:
    cs = [
        chunk(2, "1. 최통\n- 한국 기생률 높았다", 1, "1. 최통", path=["V. 선충류"], concept="회충"),
        chunk(1, "· 일반적 특징: 둥근 원주상", 1, path=["V. 선충류"], concept="선충류"),
        chunk(3, "[?]Gluagen 줄\n2. 편충\n- 채찍 모양", 2, "2. 편충", path=["V. 선충류"]),
        chunk(4, "글자만", None),  # type: ignore[arg-type]
    ]
    pages = generate.fixed_pages(cs)
    # 조각 순서대로, 상위 제목은 쪽마다 바뀔 때만, [?] 줄은 빼고, 제목 오타는 auto 태그로
    assert pages == {
        1: "V. 선충류\n· 일반적 특징: 둥근 원주상\n1. 회충\n- 한국 기생률 높았다",
        2: "V. 선충류\n2. 편충\n- 채찍 모양",
    }


def test_title_is_not_changed_when_the_tag_is_not_the_typo_shape() -> None:
    c = chunk(1, "5. 구강 편모충\n- 입 안", 1, "5. 구강 편모충", concept="질편모충")
    assert generate.chunk_text(c) == "5. 구강 편모충\n- 입 안"  # 한글 글자 수가 다름
    c2 = chunk(1, "1. 질편모충\n- 성 접촉", 1, "1. 질편모충", concept="질편모충")
    assert generate.chunk_text(c2) == "1. 질편모충\n- 성 접촉"  # 이미 본문에 있음
    assert generate.title_core("3. [?]요통 (비병원성)") == "요통"


def test_only_auto_tags_are_read_and_pages_fall_back_to_ocr_text() -> None:
    inp = job()
    inp["material"]["chunks"] = [
        {"order": 1, "text": "1. 최통\n- 높다", "title": "1. 최통", "path": [],
         "lines": [{"pageNo": 1, "lineIds": [0]}], "concept": "회충", "conceptStatus": "auto"},
        {"order": 2, "text": "1. 대장심소통\n- 대핵", "title": "1. 대장심소통", "path": [],
         "lines": [{"pageNo": 2, "lineIds": [0]}], "concept": "대장아메바",
         "conceptStatus": "review"},
    ]  # fmt: skip
    m = generate.parse(inp).material
    assert [c.concept for c in m.chunks] == ["회충", None]
    assert generate.note_pages(m) == {1: "1. 회충\n- 높다", 2: "1. 대장심소통\n- 대핵"}
    plain = generate.parse(job()).material
    assert generate.note_pages(plain) == {1: PAGE1, 2: PAGE2}


# ---------- 학습 기록 (코드) ----------


def stored(qid: str, answer: str, concept: str, state: str | None = None) -> JsonObject:
    srs = None
    if state:
        srs = {"step": 2, "dueAt": None, "lastResult": "right", "streak": 2, "reviews": 3,
               "state": state}  # fmt: skip
    return {
        "id": qid,
        "order": 1,
        "type": "정의",
        "prompt": "다음 설명에 해당하는 원충은?",
        "choices": [answer, "말라리아", "톡소포자충", "회충", "편충"],
        "answer": answer,
        "conceptTags": [concept],
        "srs": srs,
    }


def attempt(qid: str, correct: bool, set_id: str = "s1", **more: Any) -> JsonObject:
    return {
        "id": f"a-{qid}-{correct}",
        "quizSetId": set_id,
        "finishedAt": "2026-11-01T06:00:00Z",
        "answers": [{"questionId": qid, "correct": correct, **more}],
    }


def test_history_counts_wrong_answers_per_page_and_learned_concepts() -> None:
    qs = [
        stored("q1", "람블편모충", "람블편모충"),
        stored("q2", "질편모충", "질편모충"),
        stored("q3", "이질 아메바", "이질 아메바", "mastered"),
    ]
    inp = job(
        sets=[{"id": "s1", "materialId": "m1", "questions": qs}],
        attempts=[
            attempt("q1", False),
            attempt("q1", False),
            attempt("q2", False, void="정답이 둘"),  # 무효 풀이는 없는 풀이
            attempt("q2", True),
            attempt("q3", False),
            attempt("q9", False),  # 세트에 없는 문제
        ],
    )
    g = generate.parse(inp)
    per = generate.history(g.sets, g.attempts, "m1", {"m1": generate.note_pages(g.material)})
    assert (per[2].wrong, per[2].weak) == (2, ["람블편모충"])
    assert (per[1].wrong, per[1].mastered, per[1].done) == (0, 1, ["이질 아메바"])


def test_questions_of_other_notes_do_not_count() -> None:
    other = "Ⅰ. 선충류\n1. 람블편모충과 다른 회충\n- 한국\n- 높다\n- 크다"
    inp = job(
        sets=[{"id": "s2", "materialId": "m2", "questions": [stored("q1", "회충", "회충")]}],
        attempts=[attempt("q1", False, "s2")],
        notes={"m2": [{"pageNo": 1, "ocrText": other}]},
    )
    g = generate.parse(inp)
    notes = {**g.notes, "m1": generate.note_pages(g.material)}
    per = generate.history(g.sets, g.attempts, "m1", notes)
    assert all(p.wrong == 0 for p in per.values())


# ---------- 문제 만들기 (LLM) ----------


def test_a_quiz_is_made_page_by_page() -> None:
    llm = happy([GOOD["이질 아메바"], GOOD["람블편모충"]])
    result, steps = run(llm, job())
    qs = result["questions"]
    assert [(q["order"], q["answer"], q["conceptTags"]) for q in qs] == [
        (1, "이질 아메바", ["이질 아메바"]),
        (2, "람블편모충", ["람블편모충"]),
    ]
    assert [q["choices"].index(q["answer"]) for q in qs] == [0, 1]  # 정답 자리를 A~E에 고르게
    assert all(q["srs"] is None and q["type"] == "정의" and len(q["id"]) == 24 for q in qs)
    assert result["title"] == "기생충 1 원충류 맞춤 퀴즈 · 11-04"
    assert result["concepts"] is None and result["failed"] == []
    assert [(p["pageNo"], p["share"], p["plain"]) for p in result["pages"]] == [
        (1, 1, 1),
        (2, 1, 1),
    ]
    assert steps[-1][0] == 100
    gen = llm.named("Quiz")
    assert "개념 목록(이 안에서 고른다): 이질 아메바, 대장 아메바" in gen[0]
    assert "오답 보기에 정답 용어의 다른 이름" in gen[0]  # 첫 초안부터 유형별 오답 안내
    assert "이 퀴즈에서 이미 정답으로 쓴 것(정답으로 다시 쓰지 않는다): 이질 아메바" in gen[1]
    assert "복습용" not in generate.GEN_SYS and "⑦" not in generate.GEN_SYS


def test_a_rejected_draft_is_retried_with_its_problem_and_the_next_type() -> None:
    bad = draft("이질 아메바", "위족으로 운동하는 이질 아메바의 특징")  # 설명에 정답 용어
    llm = happy([bad, GOOD["이질 아메바"], GOOD["람블편모충"]])
    result, _ = run(llm, job())
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바", "람블편모충"]
    gen = llm.named("Quiz")
    assert "문제 유형: 정의" in gen[0] and "문제 유형: 특징" in gen[1]
    assert "앞서 만든 문제의 문제점: 설명에 정답 용어 노출" in gen[1]


def test_a_concept_already_asked_is_not_offered_again() -> None:
    inp = job(size=3)
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    llm = happy([GOOD["이질 아메바"], GOOD["대장 아메바"], GOOD["이질 아메바"]])
    # 모자란 세트는 돌려주지 않음(#247)
    with pytest.raises(generate.NoQuestionsError, match=re.escape("2/3문제만 만듦(물을 개념이")):
        run(llm, inp)
    gen = llm.named("Quiz")
    assert "고른다): 대장 아메바\n" in gen[1]  # 이미 물은 이질 아메바는 목록에서 뺌


def test_a_failed_slot_moves_to_another_page() -> None:
    fails = draft(
        "말라리아", "노트에 없는 원충을 묻는 설명이 여기에 들어간다", concept="이질 아메바"
    )
    inp = job(size=1)
    llm = happy([fails, fails, GOOD["람블편모충"]])
    result, _ = run(llm, inp)
    assert [q["answer"] for q in result["questions"]] == ["람블편모충"]
    gen = llm.named("Quiz")
    assert '<노트 쪽="1">' in gen[0] and '<노트 쪽="2">' in gen[2]


def test_a_draft_the_check_model_cannot_solve_is_not_used() -> None:
    llm = happy([GOOD["이질 아메바"]] * 2 + [GOOD["람블편모충"]] * 2)  # 1쪽 두 번, 2쪽 두 번
    llm.answers["Check"] = lambda u: {"answer": "E", "only_one": True, "supported": True}
    # 0문제 결과로 끝내지 않고 작업을 실패로(앱은 작업 상태로 성공 화면을 고름, #175)
    why = "만든 문제가 없음(검사 탈락(검수자 답 E))"
    with pytest.raises(generate.NoQuestionsError, match=re.escape(why)):
        run(llm, job(size=1))


def test_some_calls_failing_and_the_rest_rejected_is_not_an_outage() -> None:
    llm = happy([LlmError("503"), GOOD["이질 아메바"], GOOD["람블편모충"], GOOD["람블편모충"]])
    llm.answers["Check"] = lambda u: {"answer": "E", "only_one": True, "supported": True}
    with pytest.raises(generate.NoQuestionsError, match="검사 탈락"):  # LlmError(다시 시도)가 아님
        run(llm, job(size=1))


def test_wrong_options_that_also_fit_are_caught() -> None:
    drafts = [GOOD["이질 아메바"]] * 2 + [GOOD["람블편모충"]] * 2
    llm = happy(drafts, natural_fn=lambda u: {"natural": [True] * len(candidates(u))})
    with pytest.raises(generate.NoQuestionsError, match=r"만든 문제가 없음\(.*오답 보기: "):
        run(llm, job(size=1))  # 정의 · 특징 모두 같은 검사로 걸림


def test_a_draft_with_one_flagged_wrong_option_gets_only_that_option_replaced() -> None:
    # 질편모충도 설명에 맞다고 판정 → 새 초안 대신 그 보기만 회충으로 바꿔 다시 검사(#95)
    llm = happy(
        [GOOD["이질 아메바"]],
        natural_fn=lambda u: {"natural": [o in ("이질 아메바", "질편모충") for o in candidates(u)]},
    )
    llm.answers["Repair"] = lambda u: {"options": ["회충"]}
    inp = job(size=1)
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    result, _ = run(llm, inp)
    [q] = result["questions"]
    assert q["answer"] == "이질 아메바"
    assert "회충" in q["choices"] and "질편모충" not in q["choices"]
    assert len(llm.named("Quiz")) == 1 and len(llm.named("Repair")) == 1


def test_concept_names_are_made_when_the_note_has_none() -> None:
    inp = job(size=1)
    inp["material"]["concepts"] = []
    llm = happy([GOOD["이질 아메바"]])
    llm.answers["Concepts"] = lambda u: {"concepts": ["이질 아메바", "대장 아메바"]}
    llm.answers["Names"] = lambda u: {"items": []}
    result, _ = run(llm, inp)
    assert result["concepts"] == ["이질 아메바", "대장 아메바"]
    assert len(llm.named("Concepts")) == 2  # 5줄 이상인 쪽마다
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바"]


def test_a_note_without_text_fails_without_a_retry() -> None:
    inp = job()
    inp["material"]["pages"] = [
        {"pageNo": 1, "ocrText": "[?]흐린 줄"},
        {"pageNo": 2, "ocrText": None},
    ]
    llm = ScriptLlm({})
    with pytest.raises(InputError, match=re.escape(generate.NO_TEXT)):
        run(llm, inp)
    assert llm.calls == []


def test_a_note_without_a_page_long_enough_fails_without_a_retry() -> None:
    inp = job()
    short = "\n".join(f"줄 {i}" for i in range(generate.MIN_LINES - 1))
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": short}, {"pageNo": 2, "ocrText": short}]
    llm = happy([GOOD["이질 아메바"]])
    with pytest.raises(InputError, match=re.escape(generate.NO_TEXT)):
        run(llm, inp)
    assert llm.calls == []  # 개념 뽑기도 부르지 않음


def test_the_job_is_retried_when_every_generation_call_fails() -> None:
    down = LlmError("학교 LLM 503")
    llm = happy([down] * 6)
    with pytest.raises(LlmError):
        run(llm, job(size=1))


def test_a_setup_error_ends_the_job_without_the_other_slots_calling() -> None:
    # 학교 LLM 키 · 주소 · 모델 이름이 틀림: 남은 자리도 같으므로 기다리지 않고 올림(#262)
    def quiz(user: str) -> JsonObject:
        raise LlmSetupError("HTTP 401")

    llm = parallel_llm(quiz)
    with pytest.raises(LlmSetupError):
        run(llm, job(size=4))
    # 자리 4개가 하나씩 돎(WORKERS=1): 첫 자리가 멈춤 신호를 켜서 다음 자리는 부르지 않음
    assert len(llm.named("Quiz")) == 1


def test_every_generation_call_rejected_ends_the_job_without_retry() -> None:
    # 서버가 모두 거절(400 · 413 · 422)하면 다시 해도 같음: 일반 장애로 바꾸지 않음(Codex #264)
    llm = happy([LlmRejectedError("HTTP 413")] * 6)
    with pytest.raises(LlmRejectedError):
        run(llm, job(size=1))


def test_rejections_mixed_with_outages_are_retried() -> None:
    llm = happy([LlmRejectedError("HTTP 413"), LlmError("HTTP 503")] * 3)
    with pytest.raises(LlmError) as e:
        run(llm, job(size=1))
    assert not isinstance(e.value, LlmRejectedError)


def test_a_slot_error_is_kept_even_if_the_main_thread_leaves_first(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 자리가 멈춤 신호를 켠 뒤 끝나기 전에 주 스레드가 신호를 보고 빠져나와도(그 자리는 '아직
    # 도는 자리'로 빠짐) 오류를 잃지 않음. 자리 스레드의 set()을 1.5초 늦춰 이 순서를 만듦
    class LateEvent(threading.Event):
        def set(self) -> None:
            super().set()
            if threading.current_thread() is not threading.main_thread():
                time.sleep(1.5)  # 주 스레드의 wait(1초)가 먼저 끝남

    monkeypatch.setattr(
        generate, "threading", types.SimpleNamespace(Event=LateEvent, Lock=threading.Lock)
    )

    def quiz(user: str) -> JsonObject:
        raise LlmSetupError("HTTP 401")

    with pytest.raises(LlmSetupError):
        run(parallel_llm(quiz), job(size=1))


def test_a_slot_error_after_the_set_is_full_keeps_the_set(monkeypatch: pytest.MonkeyPatch) -> None:
    # 1문제 + 여분 자리 1: 첫 자리가 문제를 받아 다 모은 뒤에야 여분 자리가 설정 오류
    # (LlmSetupError)로 끝남. 오류는 남지만 만든 세트를 버리지 않고 돌려줌(Codex 4차 리뷰 #269).
    # 주 스레드는 다 모은 진행률 알림(report 100)에서 여분 자리가 오류를 남길 때까지 기다림
    monkeypatch.setattr(generate, "WORKERS", 8)
    monkeypatch.setattr(generate, "EXTRA", 0.6)
    second = threading.Event()  # 여분 자리의 생성 호출이 시작됨(첫 자리가 다 모으기 전에)
    full = threading.Event()  # 첫 자리의 문제가 세트에 들어감
    raised = threading.Event()  # 여분 자리가 오류를 냄
    lock = threading.Lock()
    calls = [0]

    def quiz(user: str) -> JsonObject:
        with lock:
            calls[0] += 1
            first = calls[0] == 1
        if first:
            second.wait(10)
            return by_page(user)
        second.set()
        full.wait(10)
        raised.set()
        raise LlmSetupError("HTTP 401")

    def report(value: int, step: str | None = None) -> None:
        if value == 100:  # 다 모음: 여분 자리가 오류를 남길 때까지 기다림
            full.set()
            raised.wait(10)
            time.sleep(1.0)  # guarded가 errors에 남기고 멈춤 신호를 켤 때까지(느린 CI 여유)

    result = generate.run(parallel_llm(quiz), job(size=1), report)
    assert len(result["questions"]) == 1
    assert calls[0] == 2  # 여분 자리가 실제로 돌다 오류를 냄
    join_threads("quiz-slot")


def test_an_llm_error_out_of_a_slot_is_raised_unless_the_set_is_full(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 자리 밖으로 나온 LlmError(gen_one이 잡지 못한 장애): 세트가 모자라면 그대로 올려 작업을 다시
    # 시도하고, 다 모은 뒤에 나왔으면 만든 세트를 돌려줌(Codex 5차 리뷰 #269)
    real = generate.gen_one

    def broken(*a: Any, **k: Any) -> Any:
        raise LlmError("자리 밖 장애")

    monkeypatch.setattr(generate, "gen_one", broken)
    with pytest.raises(LlmError, match="자리 밖 장애"):  # 모자람: 그 오류 그대로
        run(happy([]), job(size=1))

    # 1문제 + 여분 자리 1: 첫 자리가 세트를 다 채운 뒤 여분 자리가 LlmError로 끝남
    monkeypatch.setattr(generate, "WORKERS", 8)
    monkeypatch.setattr(generate, "EXTRA", 0.6)
    second, full, raised = threading.Event(), threading.Event(), threading.Event()
    lock = threading.Lock()
    calls = [0]

    def ordered(*a: Any, **k: Any) -> Any:
        with lock:
            calls[0] += 1
            first = calls[0] == 1
        if first:
            second.wait(10)
            return real(*a, **k)
        second.set()
        full.wait(10)
        raised.set()
        raise LlmError("자리 밖 장애")

    def report(value: int, step: str | None = None) -> None:
        if value == 100:  # 다 모음: 여분 자리가 오류로 끝날 때까지 기다림
            full.set()
            raised.wait(10)
            time.sleep(1.0)

    monkeypatch.setattr(generate, "gen_one", ordered)
    result = generate.run(parallel_llm(by_page), job(size=1), report)
    assert len(result["questions"]) == 1 and calls[0] == 2
    join_threads("quiz-slot")


@pytest.mark.usefixtures("fill_rounds")
def test_a_server_that_answered_is_not_an_outage_when_a_later_round_times_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1판: 생성은 답했지만 초안이 탈락(받은 문제 없음). 2판: 상한까지 답이 없음. 앞 판에서 서버가
    # 답했으므로 응답 없는 장애(LlmError, 작업 다시 시도)가 아니라 모자란 세트로 실패
    # (Codex 5차 리뷰 #269)
    monkeypatch.setattr(generate, "WORKERS", 8)
    monkeypatch.setattr(generate, "SEC_PER_QUESTION", 0.1)
    monkeypatch.setattr(generate, "HARD_SEC_PER_QUESTION", 0.15)
    monkeypatch.setattr(generate, "FILL_SEC_PER_QUESTION", 0.5)
    bad = draft("이질 아메바", "위족으로 운동하는 이질 아메바의 특징")  # 설명에 정답 용어
    release = threading.Event()
    lock = threading.Lock()
    calls = [0]

    def quiz(user: str) -> JsonObject:
        with lock:
            calls[0] += 1
            first_round = calls[0] <= 2  # 1판 한 자리의 유형 두 번
        if not first_round:
            release.wait(10)
        return bad

    inp = job(size=1)
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    try:
        with pytest.raises(generate.NoQuestionsError):
            run(parallel_llm(quiz), inp)
    finally:
        release.set()
    assert calls[0] > 2  # 2판이 돌다 상한에 걸림
    join_threads("quiz-slot")


def test_some_calls_failing_is_not_an_outage() -> None:
    llm = happy([LlmError("503"), GOOD["이질 아메바"]])
    result, _ = run(llm, job(size=1))
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바"]


def test_drafts_whose_two_answer_check_could_not_run_are_an_outage() -> None:
    def down(user: str) -> JsonObject:
        raise LlmError("503")

    llm = happy([GOOD["이질 아메바"]] * 2 + [GOOD["람블편모충"]] * 2, natural_fn=down)
    with pytest.raises(LlmError):  # 검사하지 못한 초안은 쓰지 않고, 모두 그러면 장애로 다시 시도
        run(llm, job(size=1))
    assert llm.named("Check") == []


# ---------- input ----------


@pytest.mark.parametrize(
    ("change", "where"),
    [
        (lambda i: i.update(day="2026/11/04"), "input.day"),
        (lambda i: i.update(size=0), "input.size"),
        (lambda i: i.pop("material"), "input.material.pages"),
        (lambda i: i["material"].update(concepts="이질"), "input.material.concepts"),
        (lambda i: i["material"].update(chunks=[{"order": 1}]), "input.material.chunks[0].text"),
        (
            lambda i: i.update(attempts=[{"id": "a", "quizSetId": "s"}]),
            "input.attempts[0].finishedAt",
        ),
    ],
)
def test_bad_input_is_rejected(change: Callable[[JsonObject], Any], where: str) -> None:
    inp = copy.deepcopy(job())
    change(inp)
    with pytest.raises(InputError, match=re.escape(where)):
        generate.parse(inp)


# ---------- /code-review 11/04 ----------


def test_a_draft_with_bad_options_does_not_close_the_page() -> None:
    four = copy.deepcopy(GOOD["이질 아메바"])
    four["question"]["options"] = four["question"]["options"][:4]  # 보기 4개(초안 잘못)
    inp = job(size=2)
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    llm = happy([four, GOOD["이질 아메바"], GOOD["대장 아메바"]])
    result, _ = run(llm, inp)
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바", "대장 아메바"]


def test_only_the_typo_shape_title_is_replaced() -> None:
    english = chunk(1, "1. Summary\n- Gram stain", 1, "1. Summary", concept="회충")
    generic = chunk(1, "1. 개요\n- 기생충이란", 1, "1. 개요", concept="회충")
    assert generate.chunk_text(english) == "1. Summary\n- Gram stain"
    assert generate.chunk_text(generic) == "1. 개요\n- 기생충이란"
    assert generate.typo_shape("최통", "회충") and generate.typo_shape("부구조통", "무구조충")
    assert not generate.typo_shape("개요", "회충")
    # 받침 없는 음절끼리 늘 같다고 보면 '개요'가 모기로 바뀜(/code-review #94)
    assert not generate.typo_shape("개요", "모기") and generate.typo_shape("보기", "모기")
    mosquito = chunk(1, "1. 개요\n- 흡혈 곤충", 1, "1. 개요", concept="모기")
    assert generate.chunk_text(mosquito) == "1. 개요\n- 흡혈 곤충"


def test_mastered_concepts_count_without_wrong_answers_and_untagged_ones_do_not() -> None:
    untagged = stored("q4", "질편모충", "x")
    del untagged["conceptTags"]
    qs = [stored("q3", "이질 아메바", "이질 아메바", "mastered"), untagged]
    inp = job(
        sets=[{"id": "s1", "materialId": "m1", "questions": qs}],
        attempts=[attempt("q4", False), attempt("q4", False)],
    )
    g = generate.parse(inp)
    per = generate.history(g.sets, g.attempts, "m1", {"m1": generate.note_pages(g.material)})
    assert (per[1].mastered, per[1].done) == (1, ["이질 아메바"])
    assert all(p.wrong == 0 and p.weak == [] for p in per.values())  # '기타'로 모으지 않음


def test_size_is_capped_and_page_numbers_may_be_digit_strings() -> None:
    with pytest.raises(InputError, match="input.size"):
        generate.parse(job(size=31))
    inp = job()
    inp["material"]["pages"][0]["pageNo"] = "1"
    assert generate.parse(inp).material.pages[0]["pageNo"] == 1


def test_pages_no_chunk_starts_on_keep_their_ocr_text() -> None:
    inp = job()
    inp["material"]["chunks"] = [
        {"order": 1, "text": "1. 최통\n- 높다", "title": "1. 최통", "path": [],
         "lines": [{"pageNo": 1}], "concept": "회충", "conceptStatus": "auto"},
        {"order": 2, "text": "쪽 없는 조각", "lines": []},
    ]  # fmt: skip
    assert generate.note_pages(generate.parse(inp).material) == {1: "1. 회충\n- 높다", 2: PAGE2}


def test_a_broken_draft_that_repeats_an_answer_does_not_close_the_page() -> None:
    # 정답이 겹친다는 판정도 보기가 망가진 초안이면 믿지 않음: 기생충 3 실제 실행(11/04)에서
    # '정답 글이 보기와 안 맞음 · 제시문에 정답 노출 · 세트 안에서 정답이 겹침' 초안 하나에
    # 1쪽이 닫힘
    again = copy.deepcopy(GOOD["이질 아메바"])
    again["question"]["options"] = again["question"]["options"][:4]
    inp = job(size=3)
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    llm = happy([GOOD["이질 아메바"], again, again, GOOD["대장 아메바"]])
    # 셋째 자리가 1쪽에서 대장 아메바를 만듦(쪽이 닫히지 않음). 세 번째 개념은 없어 모자람
    with pytest.raises(generate.NoQuestionsError, match="2/3문제만 만듦"):
        run(llm, inp)
    assert len(llm.named("Quiz")) == 4


def test_the_answer_is_stored_as_the_option_it_matched() -> None:
    # code_check는 띄어쓰기를 무시하고 보기를 찾음: '이질아메바' 정답이 '이질 아메바' 보기로
    # 통과하면 저장된 answer가 choices에 없었음(Codex 리뷰 #94)
    d = copy.deepcopy(GOOD["이질 아메바"])
    d["question"]["answer"] = "이질아메바"

    def nat(user: str) -> JsonObject:
        return {"natural": [o.replace(" ", "") == "이질아메바" for o in candidates(user)]}

    llm = ScriptLlm(
        {"Quiz": quiz_from([d]), "Naturals": nat, "Check": checker(lambda u: "이질 아메바")}
    )
    inp = job(size=1)
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    result, _ = run(llm, inp)
    q = result["questions"][0]
    assert q["answer"] == "이질 아메바" and q["answer"] in q["choices"]


def test_a_concept_still_in_review_is_not_mastered() -> None:
    # 예전 문제를 익혔어도 같은 개념의 새 문제를 계속 틀리면 약한 개념(Codex 리뷰 #94)
    qs = [
        stored("q3", "이질 아메바", "이질 아메바", "mastered"),
        stored("q5", "이질 아메바", "이질 아메바", "active"),
    ]
    inp = job(
        sets=[{"id": "s1", "materialId": "m1", "questions": qs}],
        attempts=[attempt("q5", False), attempt("q5", False)],
    )
    g = generate.parse(inp)
    per = generate.history(g.sets, g.attempts, "m1", {"m1": generate.note_pages(g.material)})
    assert (per[1].wrong, per[1].weak, per[1].mastered) == (2, ["이질 아메바"], 0)


def test_a_concept_stopped_after_five_wrong_answers_is_not_mastered() -> None:
    # 5번 풀어도 못 익혀 멈춘(stopped) 문제도 복습 중처럼 약한 개념(Codex 재리뷰 3차 #94)
    stopped = stored("q5", "이질 아메바", "이질 아메바", "stopped")
    qs = [stored("q3", "이질 아메바", "이질 아메바", "mastered"), stopped]
    inp = job(
        sets=[{"id": "s1", "materialId": "m1", "questions": qs}],
        attempts=[attempt("q5", False) for _ in range(5)],
    )
    g = generate.parse(inp)
    per = generate.history(g.sets, g.attempts, "m1", {"m1": generate.note_pages(g.material)})
    assert (per[1].wrong, per[1].weak, per[1].mastered, per[1].done) == (
        5,
        ["이질 아메바"],
        0,
        [],
    )


def test_the_weight_does_not_drop_when_the_fifth_wrong_answer_stops_a_question() -> None:
    # srs.update로 오답을 하나씩 적용: 다섯 번째 오답에 stopped가 되어도 그 쪽 가중치가 이어서
    # 오름(빼면 7.0 → 0.3, Codex 재리뷰 3차 · 4차 #94)
    learned = stored("q3", "이질 아메바", "이질 아메바", "mastered")
    old = {**attempt("q3", True), "id": "a-q3", "finishedAt": "2026-10-25T06:00:00Z"}
    st: srs.Srs | None = None
    answers: list[JsonObject] = []
    weights, states = [], []
    for i in range(1, srs.MAX_REVIEWS + 1):
        today = seoul_midnight(date(2026, 11, i))  # review.run과 같은 '오늘'(서울 자정, UTC)
        st = srs.update(st, False, today)
        done = (today + timedelta(hours=10)).isoformat()  # 그날 서울 오전 10시에 푼 풀이
        answers.append({**attempt("q5", False), "id": f"a-q5-{i}", "finishedAt": done})
        q5 = {**stored("q5", "이질 아메바", "이질 아메바"), "srs": st}
        sets = [{"id": "s1", "materialId": "m1", "questions": [learned, q5]}]
        g = generate.parse(job(sets=sets, attempts=[old, *answers]))
        pages = generate.note_pages(g.material)
        per = generate.history(g.sets, g.attempts, "m1", {"m1": pages})
        weights.append(generate.allocate(pages, per, 2)[0][1])
        states.append(st["state"])
    assert states[-2:] == ["active", "stopped"]  # 마지막 오답에 멈춤(횟수는 srs가 정함)
    assert weights == [1 + 1.5 * n for n in range(1, srs.MAX_REVIEWS + 1)]  # 오답마다 오름


def test_a_concept_learned_again_after_it_stopped_is_mastered() -> None:
    # 멈춘 뒤 새 문제를 익히면 다시 다 익힌 개념: 멈춘 문제는 다시 풀 수 없어 늘 약하다고 보면
    # 가중치가 내려가지 않음(/code-review #94). 가장 최근에 푼 문제의 상태로 봄
    qs = [
        stored("q5", "이질 아메바", "이질 아메바", "stopped"),
        stored("q7", "이질 아메바", "이질 아메바", "mastered"),
    ]
    wrong = [attempt("q5", False) for _ in range(5)]
    later = {**attempt("q7", True), "id": "a-q7-later", "finishedAt": "2026-11-03T06:00:00Z"}
    inp = job(sets=[{"id": "s1", "materialId": "m1", "questions": qs}], attempts=[*wrong, later])
    g = generate.parse(inp)
    per = generate.history(g.sets, g.attempts, "m1", {"m1": generate.note_pages(g.material)})
    assert (per[1].wrong, per[1].mastered, per[1].done) == (0, 1, ["이질 아메바"])
    # 같은 풀이에서 멈춘 문제와 익힌 문제가 함께 끝나도 다 익힌 개념(늘 약하게 남지 않음)
    same = {**attempt("q7", True), "id": "a-q7-same"}  # 멈춘 문제의 풀이와 같은 시각
    inp = job(sets=[{"id": "s1", "materialId": "m1", "questions": qs}], attempts=[*wrong, same])
    g = generate.parse(inp)
    per = generate.history(g.sets, g.attempts, "m1", {"m1": generate.note_pages(g.material)})
    assert (per[1].wrong, per[1].mastered) == (0, 1)


def test_a_concept_still_in_review_is_not_mastered_by_a_question_learned_later() -> None:
    # 복습 중인 문제가 있으면 다른 문제를 나중에 익혀도 약한 개념(/code-review #94)
    qs = [
        stored("q3", "이질 아메바", "이질 아메바", "mastered"),
        stored("q5", "이질 아메바", "이질 아메바", "active"),
    ]
    later = {**attempt("q3", True), "id": "a-q3-later", "finishedAt": "2026-11-03T06:00:00Z"}
    inp = job(
        sets=[{"id": "s1", "materialId": "m1", "questions": qs}],
        attempts=[attempt("q5", False), {**attempt("q5", False), "id": "a2"}, later],
    )
    g = generate.parse(inp)
    per = generate.history(g.sets, g.attempts, "m1", {"m1": generate.note_pages(g.material)})
    assert (per[1].wrong, per[1].mastered) == (2, 0)


def test_a_question_in_a_set_of_other_notes_is_not_made_again() -> None:
    # 오늘의 복습 세트는 노트를 섞어 materialId가 이 노트가 아님(/code-review #94)
    copied = stored("q1", "이질 아메바", "이질 아메바")
    copied["passage"] = GOOD["이질 아메바"]["question"]["passage"]
    inp = job(size=1, sets=[{"id": "t1", "materialId": "today", "questions": [copied]}])
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    llm = happy([GOOD["이질 아메바"], GOOD["대장 아메바"]])
    result, _ = run(llm, inp)
    assert [q["answer"] for q in result["questions"]] == ["대장 아메바"]
    assert "이미 있는 문제와 거의 같음" in llm.named("Quiz")[1]


def test_a_question_of_another_note_is_not_in_the_overlap_check() -> None:
    # 다른 노트 문제까지 겹침 검사에 넣으면 글이 비슷한 다른 노트 문제에 걸림(/code-review #94)
    other = stored("q1", "회충", "회충")
    other["passage"] = GOOD["이질 아메바"]["question"]["passage"]
    inp = job(
        size=1,
        sets=[{"id": "s2", "materialId": "m2", "questions": [other]}],
        notes={"m2": [{"pageNo": 1, "ocrText": "Ⅰ. 선충류\n1. 회충\n- 소장\n- 충란\n- 흔하다"}]},
    )
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    result, _ = run(happy([GOOD["이질 아메바"]]), inp)
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바"]


# ---------- 동시에 만들기 (#95) ----------


def join_threads(prefix: str) -> None:
    """돌려준 뒤 남은 스레드(이름이 prefix로 시작)가 끝나기를 기다림."""
    for t in threading.enumerate():
        if t.name.startswith(prefix):
            t.join(5)
            assert not t.is_alive()


ANSWER_OF = {d["question"]["passage"]: a for a, d in GOOD.items()}


def answer_in(user: str) -> str | None:
    """검사 호출 글에 든 초안의 정답(제시문으로 찾음). 자리가 동시에 돌아 차례로 답할 수 없음."""
    return next((a for p, a in ANSWER_OF.items() if p in user), None)


def parallel_llm(quiz: Callable[[str], JsonObject | LlmError]) -> ScriptLlm:
    return ScriptLlm(
        {
            "Quiz": quiz,
            "Naturals": lambda u: {"natural": [o == answer_in(u) for o in candidates(u)]},
            "Check": checker(answer_in),
            generate.RECHECK: checker(answer_in),
        }
    )


def by_page(user: str) -> JsonObject:
    return GOOD["이질 아메바"] if '<노트 쪽="1">' in user else GOOD["람블편모충"]


def test_slots_are_made_at_the_same_time(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(generate, "WORKERS", 8)
    both = threading.Barrier(2, timeout=5)  # 하나씩 만들면 두 번째 초안을 기다리다 시간 초과

    def quiz(user: str) -> JsonObject:
        both.wait()
        return by_page(user)

    result, steps = run(parallel_llm(quiz), job())
    qs = result["questions"]
    assert sorted(q["answer"] for q in qs) == ["람블편모충", "이질 아메바"]
    assert [q["order"] for q in qs] == [1, 2]
    # 정답 자리는 받아들인 차례(세트 순서)대로 A · B
    assert [q["choices"].index(q["answer"]) for q in qs] == [0, 1]
    assert result["failed"] == [] and steps[-1][0] == 100


def test_a_question_another_slot_took_meanwhile_is_made_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 두 자리가 동시에 이질 아메바를 만들어 둘 다 코드 검사를 지난 뒤(서로 아직 받지 않음) 검사
    # 모델에서 만남: 먼저 받은 것만 쓰고, 다른 자리는 쪽을 닫지 않고 다시 만듦
    monkeypatch.setattr(generate, "WORKERS", 8)
    inp = job(size=2)
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    both = threading.Barrier(2, timeout=5)
    lock = threading.Lock()
    drafts, checks = [0], [0]

    def quiz(user: str) -> JsonObject:
        with lock:
            drafts[0] += 1
            first_two = drafts[0] <= 2
        return GOOD["이질 아메바"] if first_two else GOOD["대장 아메바"]

    def check(user: str) -> JsonObject:
        with lock:
            checks[0] += 1
            first_two = checks[0] <= 2
        if first_two:
            both.wait()
        return checker(answer_in)(user)

    llm = parallel_llm(quiz)
    llm.answers["Check"] = check
    result, _ = run(llm, inp)
    assert sorted(q["answer"] for q in result["questions"]) == ["대장 아메바", "이질 아메바"]
    assert result["failed"] == []
    again = llm.named("Quiz")[2]
    assert f"앞서 만든 문제의 문제점: {generate.CLASH}" in again  # 쪽을 닫지 않고 다시 만듦


def test_spare_slots_stop_once_the_set_is_full(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(generate, "WORKERS", 8)
    monkeypatch.setattr(generate, "EXTRA", 1)  # 1문제에 자리 1 + 여분 1
    both = threading.Barrier(2, timeout=5)

    def quiz(user: str) -> JsonObject:
        both.wait()
        return by_page(user)

    llm = parallel_llm(quiz)
    result, _ = run(llm, job(size=1))
    assert len(result["questions"]) == 1 and result["failed"] == []  # 늦은 자리는 '다 모음'
    assert len(llm.named("Quiz")) == 2


def test_no_new_draft_is_started_after_the_time_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [0.0]
    monkeypatch.setattr(generate, "_clock", lambda: now[0])
    bad = draft("이질 아메바", "위족으로 운동하는 이질 아메바의 특징")  # 설명에 정답 용어

    def quiz(user: str) -> JsonObject:
        now[0] += 1000  # 오래 걸린 호출: 끝나면 새 초안 시간 상한이 지남
        return bad

    llm = happy([])
    llm.answers["Quiz"] = quiz
    with pytest.raises(generate.NoQuestionsError, match=re.escape(f"({generate.TIMEOUT})")):
        run(llm, job(size=1))
    assert len(llm.named("Quiz")) == 1  # 두 번째 유형 · 다른 쪽으로 넘기지 않음


def test_a_pregen_gets_a_longer_time_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    # 미리 만들기(안정적 모드)는 LLM 차례를 양보하므로 상한이 PATIENT배: 같은 느린 호출에도 문제를
    # 만듦(#138 · #274)
    now = [0.0]
    monkeypatch.setattr(generate, "_clock", lambda: now[0])

    def made(mode: generate.Mode) -> JsonObject:
        bad = draft("이질 아메바", "위족으로 운동하는 이질 아메바의 특징")  # 설명에 정답 용어
        llm = happy([bad, GOOD["이질 아메바"]])
        quiz = llm.answers["Quiz"]

        def slow(user: str) -> Any:
            now[0] += generate.SEC_PER_QUESTION * 2  # 보통 상한(1문제 20초)은 지나지만 10배 안
            return quiz(user)

        llm.answers["Quiz"] = slow
        return generate.run(llm, job(size=1), lambda v, step=None: None, mode=mode)

    assert [q["answer"] for q in made(generate.STABLE)["questions"]] == ["이질 아메바"]
    # 보통 상한이면 첫 초안이 걸린 뒤 다시 만들지 않음: 0문제 대신 작업을 실패로
    with pytest.raises(generate.NoQuestionsError):
        made(generate.FAST)


# ---------- 모드: 안정적 · 빠름 · 이어받으면 빠르게 (#274) ----------

BAD = draft(
    "이질 아메바", "위족으로 운동하는 이질 아메바의 특징"
)  # 설명에 정답 용어: 코드 검사 탈락


def page1_job(**more: Any) -> JsonObject:
    """1쪽만 있는 노트(못 만든 자리가 다른 쪽으로 넘어가지 않음)."""
    inp = job(**more)
    inp["material"] = {**inp["material"], "pages": [{"pageNo": 1, "ocrText": PAGE1}]}
    return inp


def make(llm: ScriptLlm, inp: JsonObject, **more: Any) -> JsonObject:
    return generate.run(llm, inp, lambda v, step=None: None, **more)


# 안정적 모드의 단계(시도 수 · 2차 풀기 · 이어받기)만 보는 시험: 새 유형(#268)이 끼면 초안 순서를
# 유형마다 맞춰야 해서 뺌. 새 유형은 아래 「새 유형」 시험이 봄
STEPS = replace(generate.STABLE, extra=())


def test_a_stable_slot_tries_three_drafts_and_a_fast_slot_two() -> None:
    # 안정적 모드는 한 자리 시도 3번: 빠른 모드라면 버렸을 자리를 세 번째 초안으로 채움
    llm = happy([BAD, BAD, GOOD["이질 아메바"]])
    result = make(llm, page1_job(size=1), mode=STEPS)
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바"]
    quiz = llm.named("Quiz")
    assert len(quiz) == 3
    assert "문제 유형: 분류" in quiz[2]  # 세 번째 시도는 세 번째 유형

    llm = happy([BAD, BAD, GOOD["이질 아메바"]])
    with pytest.raises(generate.NoQuestionsError):
        make(llm, page1_job(size=1))  # 기본은 빠른 모드
    assert len(llm.named("Quiz")) == 2


# 한 자리가 정의 · 특징 · 분류를 다 써 보는 모드(안정적 모드에서 부정설명 · 조합 유형을 뺌, #268)
THREE_TRIES = replace(generate.STABLE, name="three", extra=())


def test_a_classification_prompt_says_not_to_pick_a_term_of_a_used_category() -> None:
    # 분류 유형의 정답은 용어의 분류(묶음 이름): 이미 쓴 정답이 분류가 되는 용어를 고르지 않게(#282)
    line = "분류 문제: 정답(분류 이름)이 이미 정답으로 쓴 것이 되는 용어는 고르지 않는다"

    def prompts(types: list[str], used: list[str]) -> list[str]:
        llm = happy([BAD, BAD])
        generate.gen_one(llm, 1, PAGE1, types, NAMES, PageInfo(), [], used, 0)
        return llm.named("Quiz")

    assert line in prompts(["분류", "정의"], ["근족충류"])[0]
    assert all(line not in u for u in prompts(["정의", "특징"], ["근족충류"]))  # 다른 유형은 그대로
    assert line not in prompts(["분류", "정의"], [])[0]  # 쓴 정답이 없으면 넣지 않음


@pytest.mark.usefixtures("fill_rounds")
def test_classification_is_left_out_after_two_answer_clashes_in_the_set() -> None:
    # 1쪽 2문제(THREE_TRIES: 한 자리가 세 유형을 다 써 봄). 분류 초안은 늘 이미 받은 정답
    # (이질 아메바)을 내 정답 겹침으로 떨어짐. 1판 둘째 자리 · 2판 자리에서 두 번 떨어진 뒤 3판
    # 자리는 분류 유형을 빼고 정의 · 특징만으로 세 번 시도해 채움. 빼지 않으면 3판의 세 번째 시도가
    # 분류라 못 채움(#282)
    rest = [GOOD["이질 아메바"], *[BAD] * 6, GOOD["대장 아메바"]]  # 정의 · 특징 초안 차례
    kinds: list[str] = []

    def quiz(user: str) -> JsonObject:
        ty = re.findall(r"문제 유형: (\S+)", user)[0]
        kinds.append(ty)
        return BAD if ty == "분류" else rest.pop(0)  # BAD의 정답은 이질 아메바(정답 겹침)

    result = make(parallel_llm(quiz), page1_job(size=2), mode=THREE_TRIES)
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바", "대장 아메바"]
    assert kinds == [
        "정의",  # 1판 첫 자리: 이질 아메바
        "특징", "분류", "정의",  # 1판 둘째 자리: 분류 겹침 1번
        "분류", "정의", "특징",  # 2판: 분류 겹침 2번
        "특징", "정의", "특징",  # 3판: 분류를 뺀 두 유형을 돌림
    ]  # fmt: skip


@pytest.mark.usefixtures("fill_rounds")
def test_classification_is_left_out_only_on_the_page_where_it_clashed() -> None:
    # 2쪽 2문제(THREE_TRIES): 1쪽의 분류 초안은 이미 받은 정답(이질 아메바)을 내 정답 겹침으로
    # 떨어지고, 나머지 초안은 다른 이유로 떨어져 채우지 못함. 1쪽은 분류 겹침 두 번 뒤로 분류를 쓰지
    # 않지만, 2쪽은 묶음 이름이 다르므로 그 뒤에도 분류를 씀(/code-review #282)
    calls: list[tuple[int, str, int]] = []  # (쪽, 유형, 그때까지 1쪽 분류 호출 수)
    first = [True]

    def quiz(user: str) -> JsonObject:
        page = 1 if '<노트 쪽="1">' in user else 2
        ty = re.findall(r"문제 유형: (\S+)", user)[0]
        calls.append((page, ty, sum(p == 1 and t == "분류" for p, t, _ in calls)))
        if page == 1 and ty == "정의" and first[0]:
            first[0] = False
            return GOOD["이질 아메바"]
        return BAD  # 정답이 이질 아메바: 정답 겹침(분류면 셈) · 설명에 정답 용어

    with pytest.raises(generate.NoQuestionsError):
        make(parallel_llm(quiz), job(size=2), mode=THREE_TRIES)
    assert sum(p == 1 and t == "분류" for p, t, _ in calls) == 2  # 1쪽: 두 번 뒤로 뺌
    assert any(p == 2 and t == "분류" and before == 2 for p, t, before in calls)  # 2쪽은 그대로


def test_other_types_clashing_on_an_answer_do_not_leave_out_classification() -> None:
    # 정의 · 특징 초안의 정답 겹침은 세지 않음: 용어가 정답이라 노트에 많음(#282)
    r = generate.gen_one(
        happy([BAD, BAD]), 1, PAGE1, ["정의", "특징"], NAMES, PageInfo(), [], ["이질 아메바"], 0
    )
    assert generate.SAME_ANSWER in r.why and r.group_clash == 0
    r = generate.gen_one(
        happy([BAD, BAD]), 1, PAGE1, ["분류", "분류"], NAMES, PageInfo(), [], ["이질 아메바"], 0
    )
    assert r.group_clash == 2


@pytest.mark.usefixtures("fill_rounds")
@pytest.mark.parametrize(
    ("answer", "concept", "counted"),
    [
        ("이질 아메바", "대장 아메바", True),  # 정답이 겹침: 셈
        ("대장 아메바", "이질 아메바", False),  # 개념만 겹침: 세지 않음
    ],
)
def test_a_classification_answer_taken_meanwhile_by_another_slot_counts_as_a_clash(
    monkeypatch: pytest.MonkeyPatch, answer: str, concept: str, counted: bool
) -> None:
    # 1쪽 2문제를 두 자리가 동시에(THREE_TRIES). 한 자리의 분류 초안을 만드는 동안 다른 자리가
    # 정의로 이질 아메바(개념도 이질 아메바)를 받음: 분류 초안은 만들 때 겹치지 않아 검사를
    # 통과하고, 받을 때(accept) 겹침. 정답이 겹쳤으면 분류 정답 겹침으로 세어, 2판의 분류 겹침과
    # 합쳐 두 번이 되면 3판은 분류를 빼고 채움. 개념만 겹쳤으면 세지 않아 3판의 세 번째 시도도
    # 분류라 못 채움(Codex 리뷰 #293)
    monkeypatch.setattr(generate, "WORKERS", 8)
    group = draft(answer, "포낭형이 4핵인 아메바", concept=concept)
    monkeypatch.setitem(ANSWER_OF, group["question"]["passage"], answer)
    rest = [*[BAD] * 6, GOOD["대장 아메바"]]  # 첫 정의 뒤의 정의 · 특징 초안 차례
    lock = threading.Lock()
    asking = threading.Event()  # 분류 초안을 만드는 중(쓴 정답을 이미 봄)
    taken = threading.Event()  # 이질 아메바를 받음(진행률이 15%를 넘음)
    kinds: list[str] = []
    first = [True]

    def quiz(user: str) -> JsonObject:
        ty = re.findall(r"문제 유형: (\S+)", user)[0]
        with lock:
            kinds.append(ty)
            group_now = ty == "분류" and kinds.count("분류") == 1
            define_now = ty == "정의" and first[0]
            first[0] = first[0] and not define_now
            if ty == "분류" and not group_now:
                return BAD  # 2판 · 3판: 만들 때 이미 겹침(code_check)
            if not (group_now or define_now):
                return rest.pop(0)
        if define_now:  # 다른 자리가 분류 초안을 만들기 시작한 뒤에 받음
            assert asking.wait(10)
            return GOOD["이질 아메바"]
        asking.set()
        assert taken.wait(10)
        return group

    def report(value: int, step: str | None = None) -> None:
        if value > 15:
            taken.set()

    def make_set() -> JsonObject:
        return generate.run(parallel_llm(quiz), page1_job(size=2), report, mode=THREE_TRIES)

    if counted:
        result = make_set()
        assert sorted(q["answer"] for q in result["questions"]) == ["대장 아메바", "이질 아메바"]
        assert kinds.count("분류") == 2 and kinds[-3:] == ["특징", "정의", "특징"]
    else:
        with pytest.raises(generate.NoQuestionsError, match="1/2문제만 만듦"):
            make_set()
        assert kinds.count("분류") == 3 and kinds[-1] == "분류"
    join_threads("quiz-slot")


def test_an_answer_taken_meanwhile_is_its_own_reason_not_a_dry_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1쪽 2문제를 두 자리가 동시에(THREE_TRIES, 판 하나). 한 자리의 마지막 시도(정의, 정답 이질
    # 아메바)를 만드는 동안 다른 자리가 이질 아메바를 받음: 받을 때 정답이 겹친 이유는 쪽 닫기
    # 이유(세트 안에서 정답이 겹침)가 아니라 따로 적힘(/code-review #293)
    monkeypatch.setattr(generate, "WORKERS", 8)
    late = draft(
        "이질 아메바", "포낭형의 핵이 4개이고 적혈구를 먹는 원충이다", concept="대장 아메바"
    )
    monkeypatch.setitem(ANSWER_OF, late["question"]["passage"], "이질 아메바")
    lock = threading.Lock()
    asking, taken = threading.Event(), threading.Event()
    defines = [0]

    def quiz(user: str) -> JsonObject:
        ty = re.findall(r"문제 유형: (\S+)", user)[0]
        with lock:
            defines[0] += ty == "정의"
            nth = defines[0] if ty == "정의" else 0
        if nth == 1:  # 받는 자리: 다른 자리가 마지막 시도를 시작한 뒤에 끝남
            assert asking.wait(10)
            return GOOD["이질 아메바"]
        if nth == 2:  # 다른 자리의 마지막 시도(특징 · 분류 다음)
            asking.set()
            assert taken.wait(10)
            return late
        return BAD

    def report(value: int, step: str | None = None) -> None:
        if value > 15:
            taken.set()

    with pytest.raises(generate.NoQuestionsError, match="1/2문제만 만듦") as e:
        generate.run(parallel_llm(quiz), page1_job(size=2), report, mode=THREE_TRIES)
    assert generate.CLASH_SAME in str(e.value)
    assert generate.SAME_ANSWER not in str(e.value)
    join_threads("quiz-slot")


def test_a_blank_classification_draft_clashing_when_taken_still_counts() -> None:
    # 분류로 만들었지만 제시문에 ____가 있어 결과 유형이 빈칸으로 적히는 초안도, 받을 때 정답이
    # 겹치면 분류 겹침으로 셈: 결과 유형이 아니라 만든 유형으로 봄(/code-review #293)
    blank = draft("이질 아메바", "포낭형이 ____인 아메바", concept="대장 아메바")
    blank["question"]["stem"] = "다음 원충이 속하는 분류는?"
    kinds: list[str | None] = []

    def taken_meanwhile(m: generate.Made) -> list[str]:
        kinds.append(m.type)
        return [generate.CLASH_SAME]

    r = generate.gen_one(
        happy([blank, blank]), 1, PAGE1, ["분류"], NAMES, PageInfo(), [], [], 0, taken_meanwhile
    )
    assert kinds == ["빈칸", "빈칸"]  # 결과 유형은 빈칸
    assert r.group_clash == 2 and r.why == [generate.GROUP_SAME]
    # 정의 초안이 받을 때 정답이 겹치면 세지 않고, 쪽도 닫지 않음(/code-review #293)
    r = generate.gen_one(
        happy([GOOD["이질 아메바"]] * 2), 1, PAGE1, ["정의"], NAMES, PageInfo(), [], [], 0,
        taken_meanwhile,
    )  # fmt: skip
    assert r.group_clash == 0 and r.why == [generate.CLASH_SAME]
    assert not all(w in generate.DRY_REASONS for w in r.why)


def test_a_classification_answer_clash_does_not_close_the_page() -> None:
    # 분류 초안이 정답 겹침으로만 떨어져도 쪽을 닫지 않음: 묶음 이름이 바닥났을 뿐 정의 · 특징은
    # 남음. 쪽 닫기 이유(DRY_REASONS)가 아닌 다른 이유로 바꿈(/code-review #282)
    group = draft(
        "근족충류",
        "대장 아메바",
        concept="대장 아메바",
        options=["근족충류", "편모충류", "섬모충류", "포자충류", "흡충류"],
    )
    group["question"]["stem"] = "다음 원충이 속하는 분류는?"
    r = generate.gen_one(
        happy([group, group]), 1, PAGE1, ["분류"], NAMES, PageInfo(), [], ["근족충류"], 0
    )
    assert r.why == [generate.GROUP_SAME] and r.group_clash == 2
    assert not all(w in generate.DRY_REASONS for w in r.why)  # one_slot이 쪽을 닫지 않음


def test_a_two_type_page_goes_back_to_its_first_type_on_the_third_try() -> None:
    def seen_types(mode: generate.Mode) -> list[str]:
        llm = happy([BAD, BAD, BAD])
        gen = generate.gen_one(
            llm, 1, PAGE1, ["묘사", "어휘"], NAMES, PageInfo(), [], [], 0, mode=lambda: mode
        )
        assert gen.question is None and gen.tries == mode.tries
        return [re.findall(r"문제 유형: (\S+)", u)[0] for u in llm.named("Quiz")]

    assert seen_types(generate.STABLE) == ["묘사", "어휘", "묘사"]
    assert seen_types(generate.FAST) == ["묘사", "어휘"]


def test_a_stable_draft_must_also_be_solved_by_the_generator_model() -> None:
    # 안정적 모드: 검사 모델이 맞혀도 생성 모델이 다른 답을 고르면 탈락하고 다시 만듦
    llm = happy([GOOD["이질 아메바"], GOOD["이질 아메바"]])
    agree = llm.answers[generate.RECHECK]
    first = [True]

    def recheck(user: str) -> JsonObject:
        if first[0]:  # 첫 초안: 생성 모델은 다른 보기를 고름(정답 둘)
            first[0] = False
            other = "B" if "A. 이질 아메바" in user else "A"
            return {"answer": other, "only_one": False, "supported": True}
        return agree(user)

    llm.answers[generate.RECHECK] = recheck
    result = make(llm, page1_job(size=1), mode=STEPS)
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바"]
    assert len(llm.named("Quiz")) == 2 and len(llm.named(generate.RECHECK)) == 2
    assert "검사 탈락(생성 모델 답" in llm.named("Quiz")[1]  # 다시 만들 때 문제점으로 알림
    models = dict(llm.models)
    assert models["Check"] == settings.quiz_check_model
    assert models[generate.RECHECK] == settings.quiz_gen_model


def test_a_stable_draft_is_not_used_when_the_recheck_call_fails() -> None:
    llm = happy([GOOD["이질 아메바"]] * 3)
    llm.answers[generate.RECHECK] = lambda u: LlmError("응답 없음")
    # 호출 실패로 센 시도뿐이라 학교 LLM 장애: 작업 처리기가 나중에 다시 시도(검사 모델 실패와 같음)
    with pytest.raises(LlmError, match="모두 실패함"):
        make(llm, page1_job(size=1), mode=STEPS)
    assert len(llm.named(generate.RECHECK)) == 3  # 세 초안 모두 2차 풀기에서 멈춤


def test_the_fast_mode_still_checks_two_answers_and_the_checker_solve() -> None:
    # 빠르게 하려고 빼는 것은 추가 시도와 생성 모델 2차 풀기뿐: 정답 둘 검사 · 검사 모델
    # 풀기는 그대로
    llm = happy([GOOD["이질 아메바"]])
    result = make(llm, page1_job(size=1))
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바"]
    assert llm.named("Naturals") and llm.named("Check")
    assert llm.named(generate.RECHECK) == []


def test_a_pregen_taken_over_mid_slot_finishes_in_fast_mode(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 첫 초안 뒤에 사용자가 이어받음: 그 자리의 남은 시도는 빠른 모드(2번)이고, 상한이 남은 자리 ×
    # 보통 상한(지금 + 20초)으로 줄어 다른 쪽으로 넘긴 새 초안은 시작하지 않음
    now = [0.0]
    monkeypatch.setattr(generate, "_clock", lambda: now[0])

    def made(taken_over: bool) -> tuple[ScriptLlm, JsonObject | Exception]:
        awaited = [False]
        calls = [0]

        def quiz(user: str) -> JsonObject:
            now[0] += 30  # 한 초안에 30초: 안정적 모드 상한(1문제 200초) 안
            calls[0] += 1
            if taken_over:
                awaited[0] = True  # 첫 초안을 만드는 사이 사용자가 퀴즈를 누름
            return BAD if calls[0] <= 2 else by_page(user)

        llm = parallel_llm(quiz)
        out: JsonObject | Exception
        try:
            out = make(llm, job(size=1), mode=STEPS, hurry=lambda: awaited[0])
        except generate.NoQuestionsError as e:
            out = e
        return llm, out

    llm, out = made(taken_over=False)  # 그대로 안정적 모드: 세 번째 초안으로 채움
    assert isinstance(out, dict) and len(out["questions"]) == 1
    assert len(llm.named("Quiz")) == 3 and len(llm.named(generate.RECHECK)) == 1

    now[0] = 0.0
    llm, out = made(taken_over=True)
    assert isinstance(out, generate.NoQuestionsError) and generate.TIMEOUT in str(out)
    assert len(llm.named("Quiz")) == 2  # 세 번째 시도도, 다른 쪽(60초 > 30 + 20초)도 없음


def test_a_take_over_during_the_second_draft_stops_before_a_third_try() -> None:
    # 두 번째 초안을 만드는 사이 이어받음: 시도 수를 셀 때 이어받았는지 먼저 봐서 세 번째 초안을
    # 시작하지 않음(Codex 리뷰 #280)
    awaited = [False]
    llm = happy([BAD, BAD, GOOD["이질 아메바"]])
    quiz = llm.answers["Quiz"]

    def take_over_on_second(user: str) -> Any:
        if len(llm.named("Quiz")) == 2:
            awaited[0] = True
        return quiz(user)

    llm.answers["Quiz"] = take_over_on_second
    with pytest.raises(generate.NoQuestionsError):
        make(llm, page1_job(size=1), mode=STEPS, hurry=lambda: awaited[0])
    assert len(llm.named("Quiz")) == 2


def test_a_take_over_during_the_checker_solve_skips_the_recheck() -> None:
    # 검사 모델이 푸는 사이 이어받음: 생성 모델 2차 풀기를 보내지 않고 그 문제를 씀(Codex 리뷰 #280)
    awaited = [False]
    llm = happy([GOOD["이질 아메바"]])
    check = llm.answers["Check"]

    def take_over_while_checking(user: str) -> JsonObject:
        awaited[0] = True
        return check(user)

    llm.answers["Check"] = take_over_while_checking
    result = make(llm, page1_job(size=1), mode=STEPS, hurry=lambda: awaited[0])
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바"]
    assert llm.named(generate.RECHECK) == []


def test_questions_made_before_the_take_over_are_kept() -> None:
    # 이어받기 전에 안정적 모드로 만든 문제는 그대로 두고, 남은 자리만 빠른 모드로(2차 풀기 없음)
    awaited = [False]
    llm = parallel_llm(by_page)
    recheck = llm.answers[generate.RECHECK]

    def first_then_take_over(user: str) -> JsonObject:
        awaited[0] = True  # 첫 문제의 2차 풀기 뒤에 이어받음
        return recheck(user)

    llm.answers[generate.RECHECK] = first_then_take_over
    result = make(llm, job(size=2), mode=STEPS, hurry=lambda: awaited[0])
    assert sorted(q["answer"] for q in result["questions"]) == ["람블편모충", "이질 아메바"]
    assert len(llm.named(generate.RECHECK)) == 1


def test_a_pregen_taken_over_before_it_starts_is_fast_from_the_first_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 이어받은 채 시작한 미리 만들기: 첫 자리부터 빠른 모드 · 보통 상한(사용자 작업 반복을 오래
    # 막지 않게, /code-review #138)
    now = [0.0]
    monkeypatch.setattr(generate, "_clock", lambda: now[0])
    llm = happy([BAD, GOOD["이질 아메바"]])
    quiz = llm.answers["Quiz"]

    def slow(user: str) -> Any:
        now[0] += generate.SEC_PER_QUESTION * 2  # 보통 상한은 지나지만 안정적 모드 상한 안
        return quiz(user)

    llm.answers["Quiz"] = slow
    with pytest.raises(generate.NoQuestionsError):
        make(llm, job(size=1), mode=generate.STABLE, hurry=lambda: True)
    assert len(llm.named("Quiz")) == 1


def test_the_set_goes_back_at_the_hard_limit_without_waiting_for_a_slot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1쪽은 바로 만들고 2쪽은 서버가 느려 답이 상한 뒤에 옴: 기다리지 않고 1문제로 돌려주고,
    # 늦게 온 2쪽 초안은 검사 호출을 더 보내지 않음(/code-review #95)
    monkeypatch.setattr(generate, "WORKERS", 8)
    monkeypatch.setattr(generate, "SEC_PER_QUESTION", 0.2)
    monkeypatch.setattr(generate, "HARD_SEC_PER_QUESTION", 0.5)
    release = threading.Event()

    def quiz(user: str) -> JsonObject:
        if '<노트 쪽="2">' in user:
            release.wait(10)
        return by_page(user)

    llm = parallel_llm(quiz)
    start = time.monotonic()
    try:  # 1문제뿐인 세트는 돌려주지 않음(#247)
        with pytest.raises(generate.NoQuestionsError, match=re.escape("1/2문제만 만듦(시간 상한)")):
            run(llm, job(size=2))
    finally:
        release.set()
    assert time.monotonic() - start < 3
    join_threads("quiz-slot")  # 늦은 자리가 끝까지 가도록(시간이 아니라 스레드가 끝나기를)
    late = GOOD["람블편모충"]["question"]["passage"]  # 2쪽 초안의 제시문
    assert not any(late in u for u in llm.named("Naturals") + llm.named("Check"))


def test_no_answer_from_the_server_by_the_hard_limit_is_an_outage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 연결만 받고 답하지 않는 서버: 0문제 세트로 끝내지 않고 작업을 다시 시도(/code-review #95)
    monkeypatch.setattr(generate, "SEC_PER_QUESTION", 0.1)
    monkeypatch.setattr(generate, "HARD_SEC_PER_QUESTION", 0.3)
    release = threading.Event()

    def quiz(user: str) -> JsonObject:
        release.wait(10)
        return by_page(user)

    try:
        with pytest.raises(LlmError):
            run(parallel_llm(quiz), job(size=1))
    finally:
        release.set()


# ---------- 모자란 자리 다시 돌리기 (#247) ----------


@pytest.mark.usefixtures("fill_rounds")
def test_a_missing_slot_is_made_again_in_the_next_round() -> None:
    # 1판: 1쪽은 바로 통과, 2쪽 자리는 2쪽 초안 둘이 탈락하고 1쪽으로 넘겨도 겹침 → 1/2.
    # 2판: 받은 문제는 둔 채 모자란 한 자리만 다시 돌려 2쪽에서 채움
    bad = draft("람블편모충", "서양배 모양의 람블편모충 영양형의 특징")  # 설명에 정답 용어
    page2 = [bad, bad]

    def quiz(user: str) -> JsonObject:
        if '<노트 쪽="2">' in user and page2:
            return page2.pop(0)
        return by_page(user)

    llm = parallel_llm(quiz)
    result, steps = run(llm, job(size=2))
    assert sorted(q["answer"] for q in result["questions"]) == ["람블편모충", "이질 아메바"]
    assert [q["order"] for q in result["questions"]] == [1, 2]
    assert result["failed"] == [] and steps[-1][0] == 100


@pytest.mark.usefixtures("fill_rounds")
def test_rounds_stop_at_the_total_time_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    now = [0.0]
    monkeypatch.setattr(generate, "_clock", lambda: now[0])
    bad = draft("이질 아메바", "위족으로 운동하는 이질 아메바의 특징")  # 설명에 정답 용어

    def quiz(user: str) -> JsonObject:
        now[0] += generate.FILL_SEC_PER_QUESTION * 2  # 첫 초안에 전체 상한(1문제 60초)이 지남
        return bad

    llm = happy([])
    llm.answers["Quiz"] = quiz
    with pytest.raises(generate.NoQuestionsError, match=re.escape("만든 문제가 없음")):
        run(llm, job(size=1))
    assert len(llm.named("Quiz")) == 1  # 다음 판을 돌리지 않음


def slow_bad_llm(now: list[float], step: float) -> ScriptLlm:
    """초안이 늘 탈락하고 생성 호출마다 가짜 시계가 step초 가는 LLM."""
    bad = draft("이질 아메바", "위족으로 운동하는 이질 아메바의 특징")  # 설명에 정답 용어

    def quiz(user: str) -> JsonObject:
        now[0] += step
        return bad

    llm = happy([])
    llm.answers["Quiz"] = quiz
    return llm


@pytest.mark.usefixtures("fill_rounds")
@pytest.mark.parametrize("capped", [True, False])
def test_the_total_limit_is_five_minutes_even_for_ten_questions(
    monkeypatch: pytest.MonkeyPatch, capped: bool
) -> None:
    # 10문제: 60초 × 10 = 600초지만 전체 상한은 FILL_MAX_SEC(300초). 1판(새 초안 200초까지)이
    # 300초에 끝나면 다음 판을 띄우지 않음. 상한을 풀면(cap 크게) 2판이 돎
    now = [0.0]
    monkeypatch.setattr(generate, "_clock", lambda: now[0])
    if not capped:
        monkeypatch.setattr(generate, "FILL_MAX_SEC", 10**6)
    llm = slow_bad_llm(now, 100)
    with pytest.raises(generate.NoQuestionsError):
        run(llm, job(size=10))
    if capped:
        assert len(llm.named("Quiz")) == 3  # 1판만(0 · 100 · 200초에 시작)
    else:
        assert len(llm.named("Quiz")) > 3


@pytest.mark.usefixtures("fill_rounds")
@pytest.mark.parametrize(("min_round", "calls"), [(45, 2), (44, 3), (43, 3)])
def test_a_new_round_needs_min_round_sec_left(
    monkeypatch: pytest.MonkeyPatch, min_round: float, calls: int
) -> None:
    # 5문제(전체 300초), 생성 호출마다 128초: 1판 128초 · 2판 256초에 끝나 44초 남음.
    # MIN_ROUND_SEC 45초면 3판을 띄우지 않고, 44초(남은 시간과 같음) · 43초면 띄움
    now = [0.0]
    monkeypatch.setattr(generate, "_clock", lambda: now[0])
    monkeypatch.setattr(generate, "MIN_ROUND_SEC", min_round)
    llm = slow_bad_llm(now, 128)
    with pytest.raises(generate.NoQuestionsError):
        run(llm, job(size=5))
    assert len(llm.named("Quiz")) == calls


@pytest.mark.usefixtures("fill_rounds")
def test_rounds_stop_after_max_rounds() -> None:
    bad = draft("이질 아메바", "위족으로 운동하는 이질 아메바의 특징")  # 설명에 정답 용어
    llm = happy([])
    llm.answers["Quiz"] = lambda u: bad
    inp = job(size=1)
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    with pytest.raises(generate.NoQuestionsError, match="설명에 정답 용어 노출"):
        run(llm, inp)
    assert len(llm.named("Quiz")) == 2 * 3  # 판마다 한 자리 · 유형 두 번, 3판


@pytest.mark.usefixtures("fill_rounds")
def test_an_outage_round_stops_the_rounds_and_retries_the_job() -> None:
    llm = happy([])
    llm.answers["Quiz"] = lambda u: LlmError("학교 LLM 503")
    with pytest.raises(LlmError, match="모두 실패"):
        run(llm, job(size=1))
    assert len(llm.named("Quiz")) == 4  # 한 판(자리 하나 · 쪽 둘 · 유형 두 번)에서 멈춤


@pytest.mark.usefixtures("fill_rounds")
def test_the_last_stage_asks_an_asked_concept_from_another_angle() -> None:
    # 1쪽 개념 둘(이질 · 대장 아메바)로 3문제: 2판에서 열린 쪽이 없어 마지막 단계로 이미 물은
    # 개념을 다른 각도로(정답 겹침 검사는 그대로)
    angle = draft(
        "4핵",
        "이질 아메바 포낭형의 핵 수",
        concept="이질 아메바",
        options=["4핵", "8핵", "2핵", "1핵", "6핵"],
    )
    inp = job(size=3)
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    llm = happy([GOOD["이질 아메바"], GOOD["대장 아메바"], angle])
    result, _ = run(llm, inp)
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바", "대장 아메바", "4핵"]
    assert [q["conceptTags"] for q in result["questions"]][2] == ["이질 아메바"]
    last = llm.named("Quiz")[2]
    assert "이 퀴즈에서 이미 물은 개념: 이질 아메바, 대장 아메바" in last
    assert "이 퀴즈에서 이미 물은 개념" not in llm.named("Quiz")[1]  # 첫 단계에는 없음


@pytest.mark.usefixtures("fill_rounds")
def test_a_round_with_no_answer_stops_the_rounds_as_an_outage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1판의 자리가 모두 상한까지 답을 받지 못함(응답하지 않는 서버): 판을 더 돌리지 않고 LlmError로
    # 작업을 다시 시도(#95). 여러 판을 돌려도 0문제 NoQuestionsError로 끝나지 않음
    monkeypatch.setattr(generate, "WORKERS", 8)
    monkeypatch.setattr(generate, "SEC_PER_QUESTION", 0.1)
    monkeypatch.setattr(generate, "HARD_SEC_PER_QUESTION", 0.15)
    monkeypatch.setattr(generate, "FILL_SEC_PER_QUESTION", 2)
    release = threading.Event()
    calls: list[str] = []

    def quiz(user: str) -> JsonObject:
        calls.append(user)
        release.wait(10)
        return by_page(user)

    try:
        with pytest.raises(LlmError, match="모두 실패"):
            run(parallel_llm(quiz), job(size=2))
    finally:
        release.set()
    assert len(calls) == 2  # 1판의 두 자리만
    join_threads("quiz-slot")


@pytest.mark.usefixtures("fill_rounds")
def test_an_outage_after_some_questions_is_a_short_set_not_a_retry() -> None:
    # 1판에서 1문제를 만든 뒤 2판의 호출이 모두 503: 받아 둔 문제를 버리고 작업을 처음부터 다시
    # 돌리지 않고(LlmError) 모자란 세트로 실패. 1판의 탈락 이유(2쪽 자리가 1쪽으로 넘어가 겹침)도
    # 오류 글에 남음(2판은 503뿐)
    bad = draft("람블편모충", "서양배 모양의 람블편모충 영양형의 특징")  # 설명에 정답 용어
    page2 = [bad, bad]
    first_round = [True]

    def quiz(user: str) -> JsonObject | LlmError:
        if '<노트 쪽="2">' in user and page2:
            return page2.pop(0)
        if not first_round[0]:
            return LlmError("학교 LLM 503")
        if '<노트 쪽="1">' in user:
            return GOOD["이질 아메바"]
        first_round[0] = False  # 2쪽 자리가 1쪽으로 넘어감(겹침) 뒤로는 503
        return LlmError("학교 LLM 503")

    def answer(user: str) -> JsonObject:
        r = quiz(user)
        if isinstance(r, LlmError):
            raise r
        return r

    llm = parallel_llm(answer)
    with pytest.raises(generate.NoQuestionsError, match="1/2문제만 만듦") as e:
        run(llm, job(size=2))
    # 1판의 겹침은 1쪽으로 넘어간 자리의 분류 시도: 분류 정답 겹침으로 적힘(#282)
    assert "학교 LLM 503" in str(e.value) and generate.GROUP_SAME in str(e.value)


@pytest.mark.usefixtures("fill_rounds")
def test_slow_refill_rounds_end_as_a_short_set_not_an_outage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1쪽은 만들고 2쪽은 판마다 상한에 걸림: 만든 문제가 있으면 서버는 답하고 있으므로 LlmError
    # (작업 다시 시도)가 아니라 모자란 세트로 실패
    monkeypatch.setattr(generate, "WORKERS", 8)
    monkeypatch.setattr(generate, "SEC_PER_QUESTION", 0.1)
    monkeypatch.setattr(generate, "HARD_SEC_PER_QUESTION", 0.15)
    monkeypatch.setattr(generate, "FILL_SEC_PER_QUESTION", 0.3)
    release = threading.Event()
    page2: list[str] = []

    def quiz(user: str) -> JsonObject:
        if '<노트 쪽="2">' in user:
            page2.append(user)
            release.wait(10)
        return by_page(user)

    try:
        with pytest.raises(generate.NoQuestionsError, match=re.escape("1/2문제만 만듦(시간 상한)")):
            run(parallel_llm(quiz), job(size=2))
    finally:
        release.set()
    assert len(page2) >= 2  # 2판에서도 2쪽을 다시 돌림
    join_threads("quiz-slot")


@pytest.mark.usefixtures("fill_rounds")
def test_rounds_with_spare_slots_never_run_more_than_workers_at_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 여분 자리와 여러 판을 함께: 지난 판에 남아 응답을 기다리는 자리가 있어도 동시에 도는 생성
    # 호출이 WORKERS를 넘지 않음(판마다 풀을 새로 만들면 넘음, Codex 리뷰 #269)
    monkeypatch.setattr(generate, "WORKERS", 3)
    monkeypatch.setattr(generate, "EXTRA", 0.6)
    monkeypatch.setattr(generate, "SEC_PER_QUESTION", 0.1)
    monkeypatch.setattr(generate, "HARD_SEC_PER_QUESTION", 0.15)
    monkeypatch.setattr(generate, "FILL_SEC_PER_QUESTION", 1)
    bad = draft("람블편모충", "서양배 모양의 람블편모충 영양형의 특징")  # 설명에 정답 용어
    lock = threading.Lock()
    active = [0]
    peak = [0]
    calls = [0]

    def quiz(user: str) -> JsonObject:
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
            calls[0] += 1
            slow = calls[0] <= 2  # 1판의 두 자리는 상한을 넘겨 다음 판까지 워커를 잡음
        try:
            time.sleep(0.4 if slow else 0.01)
            return bad if '<노트 쪽="2">' in user else by_page(user)
        finally:
            with lock:
                active[0] -= 1

    try:
        run(parallel_llm(quiz), job(size=2))
    except (generate.NoQuestionsError, LlmError):
        pass  # 채웠는지가 아니라 동시에 도는 호출 수를 봄
    join_threads("quiz-slot")
    assert calls[0] > 3  # 1판(자리 3개) 뒤에 다음 판이 돌았음
    assert peak[0] <= 3


@pytest.mark.usefixtures("fill_rounds")
def test_a_page_closed_for_an_overlap_is_reopened_once_in_the_next_round() -> None:
    # 1쪽뿐인 노트 2문제: 둘째 자리가 두 번 모두 이미 있는 문제와 거의 같은 초안을 만들어 1쪽이
    # 겹침으로 닫힘. 다음 판에 1쪽을 한 번 다시 열어 다른 문장으로 채움(11/10 학교 LLM 기생충
    # 원충류: 세 쪽이 겹침으로 닫혀 상한 전에 3/5로 끝남, #247)
    old = stored("q1", "대장 아메바", "대장 아메바")
    old["passage"] = GOOD["대장 아메바"]["question"]["passage"]
    inp = job(size=2, sets=[{"id": "s1", "materialId": "m1", "questions": [old]}])
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    fresh = draft(
        "대장 아메바",
        "핵이 8개인 포낭을 만들고 비병원성으로 적힌 원충",
        stem="노트의 원충 가운데 알맞은 것은?",
    )
    llm = happy([GOOD["이질 아메바"], GOOD["대장 아메바"], GOOD["대장 아메바"], fresh])
    result, _ = run(llm, inp)
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바", "대장 아메바"]
    assert len(llm.named("Quiz")) == 4


@pytest.mark.usefixtures("fill_rounds")
def test_a_slot_started_before_a_page_was_reopened_does_not_close_it_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 2문제, 1쪽(틀린 기록이 있어 무거움)에 두 자리 + 여분 자리 둘(1쪽 · 2쪽). 2쪽은 늘 다른 이유로
    # 떨어져 열린 채라 마지막 단계로 가지 않음. 1판: 1쪽의 한 자리가 이질 아메바를 받고, 한 자리가
    # 겹침으로 1쪽을 닫고, 한 자리는 판 상한까지 답을 기다림. 2판: 1쪽을 다시 열고 두 자리가 다른
    # 이유로 떨어지는 동안 1판의 기다리던 자리가 겹침으로 끝남. 다시 열기 전에 시작한 자리라 1쪽을
    # 닫지 않아 3판에 채움(/code-review #247)
    monkeypatch.setattr(generate, "WORKERS", 8)
    monkeypatch.setattr(generate, "EXTRA", 1.0)
    monkeypatch.setattr(generate, "BACKUPS", 0)  # 자리마다 한 쪽만(호출 차례를 쪽으로 정함)
    # 판 상한 0.8초(1판의 기다리는 자리를 끊음) · 새 초안 0.6초: 느린 CI에서도 가짜 LLM 호출이
    # 상한 안에 끝나게 넉넉히(/code-review #247)
    monkeypatch.setattr(generate, "SEC_PER_QUESTION", 0.3)
    monkeypatch.setattr(generate, "HARD_SEC_PER_QUESTION", 0.4)
    monkeypatch.setattr(generate, "FILL_SEC_PER_QUESTION", 4)
    real = generate.gen_one
    lock = threading.Lock()
    on1 = [0]  # 1쪽 호출 차례
    second_round, stale_done = threading.Event(), threading.Event()
    started = threading.Barrier(4, timeout=5)  # 1판 네 자리
    overlap = ["세트 안에서 정답이 겹침"]  # DRY_REASONS
    other = ["정답이 노트에 없음"]  # 쪽을 닫지 않는 이유

    def scripted(*a: Any, **k: Any) -> Any:
        page = a[1]
        with lock:
            on1[0] += page == 1
            i = on1[0] if page == 1 else 0
        if page == 2:
            if not second_round.is_set():
                started.wait()
            return generate.Made(why=list(other))
        if i <= 3:  # 1판 네 자리가 모두 쪽을 연 채 시작한 뒤에 끝나게
            started.wait()
        if i == 1:
            return real(*a, **k)  # 이질 아메바
        if i == 2:
            return generate.Made(why=list(overlap))  # 1판: 1쪽을 겹침으로 닫음
        if i == 3:  # 1판에 기다리는 자리: 2판이 1쪽을 다시 연 뒤에 겹침으로 끝남
            second_round.wait(10)
            time.sleep(0.05)  # 2판 두 자리가 모두 시작할 때까지
            stale_done.set()
            return generate.Made(why=list(overlap))
        if i in (4, 5):  # 2판의 두 1쪽 자리: 늦게 끝난 1판 자리를 기다렸다가 다른 이유로 떨어짐
            second_round.set()
            stale_done.wait(10)
            return generate.Made(why=list(other))
        return real(*a, **k)  # 3판: 대장 아메바

    monkeypatch.setattr(generate, "gen_one", scripted)
    inp = job(
        size=2,
        sets=[
            {"id": "s1", "materialId": "m1", "questions": [stored("q1", "말라리아", "이질 아메바")]}
        ],
        attempts=[attempt("q1", False), attempt("q1", False)],
    )
    llm = happy([GOOD["이질 아메바"], GOOD["대장 아메바"]])
    result, _ = run(llm, inp)
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바", "대장 아메바"]
    assert on1[0] >= 6  # 3판의 1쪽 자리가 채움
    join_threads("quiz-slot")


@pytest.mark.usefixtures("fill_rounds")
def test_the_last_stage_reopens_only_pages_closed_for_no_concept(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 2쪽(틀린 기록이 있어 더 무거움)은 이미 있는 문제와 거의 같아 겹침으로 닫히고, 1쪽은 개념
    # 둘을 다 물어 닫힘. 둘째 판은 마지막 단계로 1쪽을 다시 열고, 겹침으로 처음 닫힌 2쪽도 한 번
    # 다시 엶. 2쪽은 또 겹쳐 닫힌 뒤로는 부르지 않음. 판은 둘뿐: 열린 쪽이 다시 열 쪽뿐이어도 마지막
    # 단계로 가야 둘째 판에 채움(다시 연 쪽만 도는 판을 먼저 두면 셋째 판이 필요, /code-review #247)
    monkeypatch.setattr(generate, "MAX_ROUNDS", 2)
    old = stored("q1", "람블편모충", "람블편모충")
    old["passage"] = GOOD["람블편모충"]["question"]["passage"]
    inp = job(
        size=3,
        sets=[{"id": "s1", "materialId": "m1", "questions": [old]}],
        attempts=[attempt("q1", False)],
    )
    angle = draft(
        "4핵", "이질 아메바 포낭형의 핵 수", concept="이질 아메바",
        options=["4핵", "8핵", "2핵", "1핵", "6핵"],
    )  # fmt: skip
    page1 = quiz_from([GOOD["이질 아메바"], GOOD["대장 아메바"], angle])
    calls: list[tuple[int, bool]] = []  # (쪽, 마지막 단계 안내가 있는지)
    last_answer = [""]

    def quiz(user: str) -> JsonObject:
        on2 = '<노트 쪽="2">' in user
        calls.append((2 if on2 else 1, "이 퀴즈에서 이미 물은 개념" in user))
        r = GOOD["람블편모충"] if on2 else page1(user)
        assert not isinstance(r, LlmError)
        last_answer[0] = r["question"]["answer"]
        return r

    llm = ScriptLlm(
        {
            "Quiz": quiz,
            "Naturals": lambda u: {"natural": [o == last_answer[0] for o in candidates(u)]},
            "Check": checker(lambda u: last_answer[0]),
        }
    )
    result, _ = run(llm, inp)
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바", "대장 아메바", "4핵"]
    # 2쪽은 첫 판의 한 자리(gen_one이 유형마다 한 번)에서 겹침으로 닫히고, 둘째 판에 한 번 다시
    # 열렸다가 또 겹쳐 닫힘(#247)
    once = len(generate.page_types(PAGE2, generate.is_korean_subject({1: PAGE1, 2: PAGE2}))[:2])
    assert [page for page, _ in calls].count(2) == 2 * once
    assert not any(angled for page, angled in calls if page == 2)  # 마지막 단계에서는 부르지 않음
    assert calls[-1] == (1, True)  # 마지막 단계는 1쪽에서 이미 물은 개념을 다른 각도로


@pytest.mark.usefixtures("fill_rounds")
def test_a_page_closed_for_an_overlap_in_the_last_stage_is_not_reopened() -> None:
    # 1쪽 개념 둘로 3문제: 1판에 둘을 받고 1쪽은 개념이 바닥나 닫힘. 2판(마지막 단계)에 1쪽을 다시
    # 열었지만 두 번 모두 같은 정답이라 겹침으로 닫힘. 마지막 단계에서 처음 겹친 쪽은 다시 열지
    # 않아 3판을 띄우지 않음(/code-review #247)
    inp = job(size=3)
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    llm = happy([GOOD["이질 아메바"], GOOD["대장 아메바"], *[GOOD["이질 아메바"]] * 4])
    with pytest.raises(generate.NoQuestionsError, match=re.escape("2/3문제만 만듦")):
        run(llm, inp)
    assert len(llm.named("Quiz")) == 4  # 1판 둘 · 2판 한 자리의 두 유형


@pytest.mark.usefixtures("fill_rounds")
def test_the_last_stage_asks_a_concept_at_most_twice() -> None:
    # 1쪽 개념 둘로 5문제: 마지막 단계에서도 한 개념은 두 문제까지라 4문제에서 더 물을 개념이 없음
    def angle(answer: str, concept: str, options: list[str]) -> JsonObject:
        return draft(answer, f"{concept} 포낭형의 핵 수", concept=concept, options=options)

    nuclei = ["4핵", "8핵", "2핵", "1핵", "6핵"]
    inp = job(size=5)
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    llm = happy(
        [
            GOOD["이질 아메바"],
            GOOD["대장 아메바"],
            angle("4핵", "이질 아메바", nuclei),
            angle("8핵", "대장 아메바", [nuclei[1], nuclei[0], *nuclei[2:]]),
        ]
    )
    with pytest.raises(generate.NoQuestionsError, match=re.escape("4/5문제만 만듦")):
        run(llm, inp)
    assert len(llm.named("Quiz")) == 4  # 두 번씩 물은 뒤로는 고를 개념이 없어 부르지 않음


def test_a_question_the_server_would_drop_is_not_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    # 서버 모양 검사(fromWorkerQuestion)에 걸릴 문제는 받지 않고 그 자리가 다시 만듦
    checks: list[bool] = []
    shape_ok = generate._shape_ok

    def first_bad(d: Any) -> bool:
        checks.append(shape_ok(d))
        return len(checks) > 1

    monkeypatch.setattr(generate, "_shape_ok", first_bad)
    llm = happy([GOOD["이질 아메바"], GOOD["이질 아메바"]])
    result, _ = run(llm, job(size=1))
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바"]
    gen = llm.named("Quiz")
    assert len(gen) == 2 and f"앞서 만든 문제의 문제점: {generate.BAD_SHAPE}" in gen[1]


@pytest.mark.parametrize(
    ("change", "ok"),
    [
        ({}, True),
        ({"stem": "  "}, False),
        ({"answer": ""}, False),
        ({"answer": "없는 보기"}, False),
        ({"options": ["이질 아메바", "대장 아메바", "람블편모충", "질편모충"]}, False),
        ({"options": ["이질 아메바", "대장 아메바", "람블편모충", "질편모충", " "]}, False),
        ({"options": ["이질 아메바", "대장 아메바", "람블편모충", "질편모충", 3]}, False),
    ],
)
def test_shape_matches_the_server_check(change: dict[str, Any], ok: bool) -> None:
    d = {**GOOD["이질 아메바"]["question"], **change}
    assert generate._shape_ok(d) is ok


def test_slots_never_started_are_reported_as_not_made(monkeypatch: pytest.MonkeyPatch) -> None:
    # 자리 2개에 동시에 1개: 첫 자리가 상한까지 끝나지 않아 둘째 자리는 시작하지 못함(취소)
    monkeypatch.setattr(generate, "SEC_PER_QUESTION", 0.1)
    monkeypatch.setattr(generate, "HARD_SEC_PER_QUESTION", 0.15)
    release = threading.Event()

    def quiz(user: str) -> JsonObject:
        release.wait(10)
        return by_page(user)

    try:
        with pytest.raises(LlmError):  # 만든 문제가 없음: 장애
            run(parallel_llm(quiz), job(size=2))
    finally:
        release.set()
    # 만든 문제가 있을 때 취소된 자리도 failed에 남는지
    monkeypatch.setattr(generate, "HARD_SEC_PER_QUESTION", 0.5)
    started = threading.Event()
    release2 = threading.Event()

    def quiz2(user: str) -> JsonObject:
        if started.is_set():
            release2.wait(10)
        started.set()
        return GOOD["이질 아메바"]

    inp = job(size=3)
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    try:  # 도는 자리 1 + 시작하지 못한 자리 1: 모자란 세트는 돌려주지 않음(#247)
        with pytest.raises(generate.NoQuestionsError, match=re.escape("1/3문제만 만듦(시간 상한)")):
            run(parallel_llm(quiz2), inp)
    finally:
        release2.set()


def test_concept_names_of_pages_are_made_at_the_same_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(generate, "WORKERS", 8)
    inp = job(size=1)
    inp["material"]["concepts"] = []
    both = threading.Barrier(2, timeout=5)  # 쪽마다 차례로 뽑으면 시간 초과

    def names(user: str) -> JsonObject:
        both.wait()
        if "람블편모충" in user:
            return {"concepts": ["람블편모충", "질편모충"]}
        return {"concepts": ["이질 아메바", "대장 아메바"]}

    llm = parallel_llm(by_page)
    llm.answers["Concepts"] = names
    llm.answers["Names"] = lambda u: {"items": []}
    result, _ = run(llm, inp)
    assert result["concepts"] == NAMES  # 쪽 순서대로 합침
    assert len(result["questions"]) == 1


def test_a_later_page_failing_stops_concept_names_without_waiting_for_an_earlier_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 1쪽은 느리고 2쪽이 먼저 실패: 1쪽이 끝나기를 기다리지 않고 바로 다시 시도로, 늦게 끝난 1쪽은
    # 검사(Names) 호출을 더 하지 않음(Codex 리뷰 #125)
    monkeypatch.setattr(generate, "WORKERS", 8)
    inp = job(size=1)
    inp["material"]["concepts"] = []
    release = threading.Event()

    def names(user: str) -> JsonObject | LlmError:
        if "람블편모충" in user:
            return LlmError("HTTP 503")
        release.wait(10)
        return {"concepts": ["이질 아메바", "대장 아메바"]}

    llm = parallel_llm(by_page)
    llm.answers["Concepts"] = names
    llm.answers["Names"] = lambda u: {"items": []}
    start = time.monotonic()
    try:
        with pytest.raises(LlmError):
            run(llm, inp)
    finally:
        release.set()
    assert time.monotonic() - start < 3
    join_threads("concepts")  # 늦은 1쪽이 끝까지 가도록
    assert llm.named("Names") == []


# ---------- 새 유형 · 난이도 (#268) ----------

FEATURES = {  # 특징 · 부정설명 보기: 노트로 확인되는 옳은 설명(이름은 넣지 않음: 정답 겹침 검사)
    "이질 아메바": [
        "위족으로 운동한다",
        "적혈구를 먹는다",
        "포낭형은 4핵이다",
        "인체 감염형이 있다",
    ],
    "대장 아메바": ["포낭형은 8핵이다", "병을 일으키지 않는다", "근족충류이다", "포낭형이 있다"],
    "람블편모충": ["서양배 모양이다", "흡착원판이 있다", "포낭형은 타원형이다", "포낭형은 4핵이다"],
    "질편모충": ["성 접촉으로 감염된다", "편모충류이다", "원충이다", "편모로 움직인다"],
}
GROUP = {"이질 아메바": "근족충류", "대장 아메바": "근족충류", "람블편모충": "편모충류"}
GROUP["질편모충"] = "편모충류"


def typed_draft(ty: str, concept: str) -> JsonObject:
    """요청한 유형에 맞는 초안(모든 검사를 통과하는 모양)."""
    true4 = FEATURES[concept]
    if ty == "정의":
        return GOOD[concept]
    if ty == "특징":
        stem, options, answer = (
            f"다음 중 {concept}에 대한 설명으로 옳은 것은?",
            # 오답 보기도 개념마다 다른 문장(같으면 too_close의 '문장 보기 셋이 같음')
            [
                true4[0],
                "섬모로 움직인다",
                f"{concept}는 세균이다",
                f"{concept}는 곰팡이다",
                f"{concept}는 바이러스다",
            ],  # fmt: skip
            true4[0],
        )
    elif ty == "부정설명":
        stem, options, answer = (
            f"다음 중 {concept}에 대한 설명으로 옳지 않은 것은?",
            ["섬모로 움직인다", *true4],
            "섬모로 움직인다",
        )
    elif ty == "분류":
        stem, options, answer = (
            f"{concept}가 속하는 분류는?",
            ["근족충류", "편모충류", "섬모충류", "포자충류", "흡충류"],
            GROUP[concept],
        )
    else:
        raise AssertionError(f"이 시험이 준비하지 않은 유형: {ty}")
    return {
        "question": {
            "stem": stem,
            "passage": concept,
            "options": options,
            "answer": answer,
            "explanation": "노트에 적힌 내용입니다.",
            "difficulty": "보통",
            "concept": concept,
        }
    }


def first_name(user: str) -> str:
    m = re.search(r"^개념 목록\(이 안에서 고른다\): ([^,\n]+)", user, re.M)
    assert m
    return m.group(1)


def typed_llm() -> ScriptLlm:
    """유형마다 알맞은 초안을 쓰고, 조합형은 요청한 묶음대로 문장을 쓰는 가짜 LLM(차례로 답함)."""
    made: list[str] = []
    asked: list[list[bool]] = []

    def quiz(user: str) -> JsonObject:
        ty = re.search(r"^문제 유형: (\S+)", user, re.M)
        assert ty
        d = typed_draft(ty.group(1), first_name(user))
        made.append(d["question"]["answer"])
        return d

    def statements(user: str) -> JsonObject:
        m = re.search(r"이 순서로 만든다: (.+)$", user, re.M)
        assert m
        asked.append(["옳음" in x for x in m.group(1).split(", ")])
        made.append(", ".join(c for c, w in zip("ㄱㄴㄷ", asked[-1], strict=True) if w))
        concept = first_name(user)
        # 개념마다 다른 문장(같으면 '이미 있는 문제와 거의 같음')
        st = ["위족으로 운동한다.", "포낭형은 8핵이다.", "적혈구를 먹는다."]
        st = st if concept == "이질 아메바" else [f"{concept}: {x}" for x in FEATURES[concept][:3]]
        return {
            "question": {
                "concept": concept,
                "statements": st,
                "reasons": ["노트와 같다", "포낭형은 4핵이다", "노트와 같다"],
            }
        }

    def nat(user: str) -> JsonObject:
        return {"natural": [o == made[-1] for o in candidates(user)]}

    return ScriptLlm(
        {
            "Quiz": quiz,
            "Naturals": nat,
            "Check": checker(lambda u: made[-1]),
            generate.RECHECK: checker(lambda u: made[-1]),
            "Combo": statements,
            "Verify": lambda u: {"correct": asked[-1]},
        }
    )


def asked_types(llm: ScriptLlm) -> list[str]:
    out = []
    for name, user in llm.calls:
        if name == "Quiz" and (m := re.search(r"^문제 유형: (\S+)", user, re.M)):
            out.append(m.group(1))
        elif name == "Combo":
            out.append("조합")
    return out


def test_the_new_types_are_added_only_in_stable_mode_and_only_to_term_pages() -> None:
    assert generate.page_types(PAGE1, True) == ["정의", "특징", "분류"]
    assert generate.page_types(PAGE1, True, generate.STABLE.extra) == [
        "정의", "특징", "부정설명", "분류", "조합",
    ]  # fmt: skip
    assert generate.page_types("The box is ____.", False, generate.STABLE.extra) == [
        "빈칸", "어휘", "규칙",
    ]  # fmt: skip
    assert generate.FAST.extra == ()


def test_a_stable_set_turns_the_first_type_slot_by_slot_and_tags_difficulty() -> None:
    # 쪽마다 돌리면 쪽마다 정의부터: 세트 전체에서 자리마다 돌려 유형 · 난이도가 섞임
    llm = typed_llm()
    result = make(llm, job(size=4), mode=generate.STABLE)
    qs = result["questions"]
    assert [q["type"] for q in qs] == ["정의", "특징", "부정설명", "분류"]
    assert [q["difficulty"] for q in qs] == ["하", "중", "중", "하"]
    neg = qs[2]
    assert neg["prompt"].endswith("옳지 않은 것은?") and neg["answer"] == "섬모로 움직인다"
    # 부정설명의 정답(틀린 설명)은 '이미 정답으로 쓴 것'으로 다음 초안 지시에 싣지 않음
    last = llm.named("Quiz")[-1]
    assert "이미 정답으로 쓴 것" in last and "섬모로 움직인다" not in last

    llm = typed_llm()
    result = make(llm, job(size=4))  # 빠른 모드는 지금처럼 쪽마다 정의부터
    assert [q["type"] for q in result["questions"]] == ["정의", "특징", "정의", "특징"]
    assert [q["difficulty"] for q in result["questions"]] == ["하", "중", "하", "중"]


def test_a_combination_is_built_by_code_and_checked_statement_by_statement() -> None:
    llm = typed_llm()
    r = generate.gen_one(
        llm, 1, PAGE1, ["조합"], NAMES[:2], PageInfo(), [], [], 2, mode=lambda: generate.STABLE
    )
    q = r.question
    assert q is not None and r.type == "조합" and r.concept == "이질 아메바"
    assert q["passage"] == "ㄱ. 위족으로 운동한다.\nㄴ. 포낭형은 8핵이다.\nㄷ. 적혈구를 먹는다."
    assert q["options"] == sorted(q["options"], key=generate.combo.COMBOS.index)
    assert q["answer"] in q["options"]
    # 정답 둘 검사(Naturals) 대신 문장 판정, 그 뒤 검사 모델 풀기 · 생성 모델 2차 풀기
    assert [n for n, _ in llm.calls] == ["Combo", "Verify", "Check", generate.RECHECK]


def test_a_combination_judged_otherwise_is_retried_with_the_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(generate.combo, "truth_for", lambda: "ㄱ")
    llm = typed_llm()
    llm.answers["Verify"] = lambda u: {"correct": [True, True, True]}
    r = generate.gen_one(
        llm, 1, PAGE1, ["조합"], NAMES[:2], PageInfo(), [], [], 0, mode=lambda: generate.STABLE
    )
    assert r.question is None and r.tries == 3
    combos = llm.named("Combo")
    assert "문장 판정이 요청과 다름" in combos[1] and "문장 판정이 요청과 다름" not in combos[0]


def test_fast_mode_skips_the_new_types() -> None:
    llm = typed_llm()
    r = generate.gen_one(
        llm, 1, PAGE1, ["조합", "부정설명", "정의"], NAMES[:2], PageInfo(), [], [], 0,
        mode=lambda: generate.FAST,
    )  # fmt: skip
    assert r.type == "정의" and asked_types(llm) == ["정의"]


def test_a_take_over_mid_slot_drops_the_new_types_for_the_remaining_tries() -> None:
    llm = typed_llm()
    llm.answers["Quiz"] = lambda u: BAD
    modes = iter([generate.STABLE])  # 첫 시도(시도 수 · 유형)까지만 안정적

    def mode() -> generate.Mode:
        return next(modes, generate.FAST)

    generate.gen_one(
        llm, 1, PAGE1, ["부정설명", "정의", "조합", "특징"], NAMES[:2], PageInfo(), [], [], 0,
        mode=mode,
    )  # fmt: skip
    # 이어받지 않았으면 두 번째 시도는 정의 · 세 번째는 조합. 빠른 모드로 바뀌어 [정의, 특징] 중
    # 두 번째(특징)이고 시도는 2번에서 끝남
    assert asked_types(llm) == ["부정설명", "특징"]


def test_combinations_may_share_an_answer_and_keep_their_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(generate, "page_types", lambda text, korean, extra=(): ["조합"])
    monkeypatch.setattr(generate.combo, "truth_for", lambda: "ㄱ, ㄷ")
    llm = typed_llm()
    result = make(llm, job(size=3), mode=generate.STABLE)
    qs = result["questions"]
    assert [q["answer"] for q in qs] == ["ㄱ, ㄷ"] * 3  # 묶음 이름이라 겹쳐도 됨
    # 세트 순서로 정답 자리를 다시 놓을 때도(_make_all) 묶음 순서 그대로
    order = generate.combo.COMBOS.index
    assert all(q["choices"] == sorted(q["choices"], key=order) for q in qs)
    assert all(q["answer"] in q["choices"] for q in qs)
    assert [q["difficulty"] for q in qs] == ["상"] * 3
    assert "ㄱ, ㄷ" not in "".join(llm.named("Combo"))  # 이미 쓴 정답 목록에 넣지 않음


# ---------- 난이도 비율 (#268) ----------


def kinds_of(made: JsonObject) -> list[tuple[str, str]]:
    return [(q["type"], q["difficulty"]) for q in made["questions"]]


@pytest.mark.usefixtures("mixed_levels")
def test_a_set_follows_the_level_mix_slot_by_slot() -> None:
    # 기록이 없으면 하 2 : 중 2 : 상 1. 4문제: 하 2 · 중 1 · 상 1, 자리마다 하 · 중 · 상 · 하
    result = make(typed_llm(), job(size=4), mode=generate.STABLE)
    assert result["levels"] == {"target": {"하": 2, "중": 1, "상": 1}, "weak": None, "user": {}}
    # 같은 난이도 안의 유형은 난이도마다 돌림: 하는 정의 → 분류(Codex 리뷰 #300)
    assert kinds_of(result) == [("정의", "하"), ("특징", "중"), ("조합", "상"), ("분류", "하")]


@pytest.mark.usefixtures("mixed_levels")
def test_fast_mode_mixes_the_levels_it_has() -> None:
    # 빠른 모드의 용어 과목은 하 · 중뿐: 쪽마다 정의 · 특징(#268 전과 같은 결과)
    result = make(typed_llm(), job(size=4))
    assert result["levels"]["target"] == {"하": 2, "중": 2}
    assert kinds_of(result) == [("정의", "하"), ("특징", "중"), ("정의", "하"), ("특징", "중")]


@pytest.mark.usefixtures("mixed_levels")
def test_a_weak_level_gets_more_questions() -> None:
    # 다른 노트에서 '상' 문제 5개 중 3개를 틀림: 다음 세트는 상을 하나 더
    old = [
        {**stored(f"o{i}", "편충", "편충"), "type": "조합", "difficulty": "상"} for i in range(5)
    ]
    attempts = [attempt(f"o{i}", i >= 3, set_id="old") for i in range(5)]
    inp = job(size=4, sets=[{"id": "old", "materialId": "m2", "questions": old}], attempts=attempts)
    result = make(typed_llm(), inp, mode=generate.STABLE)
    assert result["levels"] == {
        "target": {"하": 1, "중": 1, "상": 2},
        "weak": "상",
        "user": {"상": [5, 3]},
    }
    assert [d for _, d in kinds_of(result)].count("상") == 2


@pytest.mark.usefixtures("mixed_levels")
def test_everyones_rates_correct_the_type_levels() -> None:
    # 모든 사용자가 조합을 90% 맞힘: 조합은 중. 그러면 이 노트에 '상' 유형이 없어 하 · 중으로만
    inp = job(size=4, typeStats={"조합": {"answered": 40, "correct": 36}, "정의": "망가짐"})
    result = make(typed_llm(), inp, mode=generate.STABLE)
    assert result["levels"]["target"] == {"하": 2, "중": 2}
    assert all(d == "중" for t, d in kinds_of(result) if t == "조합")


@pytest.mark.parametrize(
    "stats",
    [
        {"조합": {"answered": 40, "correct": 41}},  # 맞힌 수가 더 많음
        {"조합": {"answered": -1, "correct": 0}},
        {"조합": {"answered": True, "correct": 0}},
        {"조합": [40, 36]},
        "망가짐",
    ],
)
def test_bad_type_stats_are_ignored(stats: object) -> None:
    assert generate.parse(job(typeStats=stats)).type_stats == {}


@pytest.mark.usefixtures("mixed_levels", "fill_rounds")
def test_the_next_round_starts_with_the_level_still_lacking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 하 1 · 상 1인데 상 자리(조합)가 모두 떨어짐: 다음 판의 자리는 처음 차례(하)가 아니라
    # 모자란 상부터
    monkeypatch.setattr(generate.levels, "level_mix", lambda n, usable, stats: {"하": 1, "상": 1})
    monkeypatch.setattr(generate.combo, "truth_for", lambda: "ㄱ")
    llm = typed_llm()
    llm.answers["Verify"] = lambda u: {"correct": [True, True, True]}  # 늘 요청과 다름
    quiz = llm.answers["Quiz"]
    llm.answers["Quiz"] = lambda u: quiz(u) if "문제 유형: 정의" in u else BAD
    firsts: list[str] = []
    gen_one = generate.gen_one

    def spy(*a: Any, **k: Any) -> Any:
        firsts.append(a[3][0])
        return gen_one(*a, **k)

    monkeypatch.setattr(generate, "gen_one", spy)
    with pytest.raises(generate.NoQuestionsError):
        make(llm, page1_job(size=2), mode=generate.STABLE)
    assert firsts[0] == "정의" and firsts[1] == "조합"
    assert len(firsts) > 2 and set(firsts[2:]) == {"조합"}  # 다음 판들도 상(조합)부터


def concurrent_llm(
    slow: str,
    gate: threading.Event,
    fail_after: bool = False,
    pick: Callable[[list[str]], str | None] | None = None,
) -> ScriptLlm:
    """여러 자리가 동시에 불러도 되는 가짜 LLM: 제시문으로 정답을 찾음. slow 유형의 초안은 gate가
    켜질 때까지(늦어도 5초) 기다렸다가 오고, 늘 마지막 개념(질편모충)을 씀(pick이 있으면 pick이
    고른 개념, None이면 탈락 초안). 다른 유형은 앞의 개념부터 자리마다 다르게 고름(스레드 차례에
    기대지 않게)."""
    lock = threading.Lock()
    answer_of: dict[str, str] = {}
    handed: list[str] = []

    def quiz(user: str) -> JsonObject:
        ty = re.search(r"^문제 유형: (\S+)", user, re.M)
        listed = re.search(r"^개념 목록\(이 안에서 고른다\): (.+)$", user, re.M)
        assert ty and listed
        names = listed.group(1).split(", ")
        if ty.group(1) == slow:
            gate.wait(5)
        with lock:
            picked = pick(names) if pick is not None and ty.group(1) == slow else None
        if pick is not None and ty.group(1) == slow and picked is None:
            return BAD
        # 비워 둔 뒤의 초안은 모두 탈락(맡은 자리가 끝내 실패). pick이 고른 초안은 빼고
        if fail_after and gate.is_set() and picked is None:
            return BAD
        with lock:
            if picked is not None:
                concept = picked
            elif ty.group(1) == slow:
                concept = names[-1]
            else:
                concept = next(c for c in names[:-1] if c not in handed)
                handed.append(concept)
            d = typed_draft(ty.group(1), concept)
            answer_of[d["question"]["passage"]] = d["question"]["answer"]
        return d

    def passage_in(user: str) -> str | None:
        lines = user.split("\n")
        i = next((k for k, ln in enumerate(lines) if ln.startswith("문제: ")), None)
        with lock:
            return answer_of.get(lines[i + 1]) if i is not None and i + 1 < len(lines) else None

    def nat(user: str) -> JsonObject:
        head = user.split("\n")[0].split(": ", 1)[-1]
        with lock:
            right = answer_of.get(head)
        return {"natural": [o == right for o in candidates(user)]}

    return ScriptLlm(
        {
            "Quiz": quiz,
            "Naturals": nat,
            "Check": checker(passage_in),
            generate.RECHECK: checker(passage_in),
        }
    )


@pytest.mark.usefixtures("mixed_levels")
def test_a_spare_question_waits_for_a_slower_level_still_running(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 하 1 · 중 1인데 중(특징) 초안이 늦음: 먼저 끝난 하 여분 문제가 남은 자리를 차지하면 중이
    # 0문제였음. 아직 도는 중 자리에 자리를 비워 둠(Codex 리뷰 #300). 특징 초안은 하 여분 문제를
    # 비워 둔 뒤에야 옴(gate)
    monkeypatch.setattr(generate, "WORKERS", 8)
    monkeypatch.setattr(generate, "EXTRA", 0.5)  # 2문제에 자리 2 + 여분 1(하)
    monkeypatch.setattr(generate, "page_types", lambda text, korean, extra=(): ["정의", "특징"])
    monkeypatch.setattr(generate.levels, "level_mix", lambda n, usable, stats: {"하": 1, "중": 1})
    gate = threading.Event()
    real_held = generate.levels.held

    def held(*a: Any, **k: Any) -> bool:
        out = real_held(*a, **k)
        if out:
            gate.set()
        return out

    monkeypatch.setattr(generate.levels, "held", held)
    one_page = job(size=2)
    one_page["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1 + "\n" + PAGE2}]
    result = make(concurrent_llm("특징", gate), one_page)
    join_threads("quiz-slot")
    assert gate.is_set(), "하 여분 문제를 비워 두지 않음"
    assert sorted(kinds_of(result)) == [("정의", "하"), ("특징", "중")]
    assert result["failed"] == []


@pytest.mark.usefixtures("mixed_levels")
def test_types_turn_within_each_level_even_when_levels_alternate_on_a_page(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 빠른 모드 한 쪽에 하 · 중 · 하: 쪽 방문 수 하나로 돌리면 세 번째 자리(하)도 정의부터였음.
    # 난이도마다 세어 하는 정의 → 분류(Codex 리뷰 #300)
    firsts: list[str] = []
    gen_one = generate.gen_one

    def spy(*a: Any, **k: Any) -> Any:
        firsts.append(a[3][0])
        return gen_one(*a, **k)

    monkeypatch.setattr(generate, "gen_one", spy)
    one_page = job(size=3)
    one_page["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1 + "\n" + PAGE2}]
    make(typed_llm(), one_page)
    assert firsts[:3] == ["정의", "특징", "분류"]


@pytest.mark.usefixtures("mixed_levels")
def test_a_held_spare_question_is_used_when_the_slot_it_waited_for_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 하 여분 문제를 중 자리에 비워 뒀는데 중 자리가 끝내 실패: 비워 둔 문제를 버리면 1/2문제로
    # 세트가 실패했음. 보관했다가 그 자리가 끝날 때 다시 받음(Codex 재리뷰 #300)
    monkeypatch.setattr(generate, "WORKERS", 8)
    monkeypatch.setattr(generate, "EXTRA", 0.5)
    monkeypatch.setattr(generate, "page_types", lambda text, korean, extra=(): ["정의", "특징"])
    monkeypatch.setattr(generate.levels, "level_mix", lambda n, usable, stats: {"하": 1, "중": 1})
    gate = threading.Event()
    real_held = generate.levels.held

    def held(*a: Any, **k: Any) -> bool:
        out = real_held(*a, **k)
        if out:
            gate.set()
        return out

    monkeypatch.setattr(generate.levels, "held", held)
    one_page = job(size=2)
    one_page["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1 + "\n" + PAGE2}]
    result = make(concurrent_llm("특징", gate, fail_after=True), one_page)
    join_threads("quiz-slot")
    assert gate.is_set()
    assert kinds_of(result) == [("정의", "하"), ("정의", "하")]


@pytest.mark.usefixtures("mixed_levels")
def test_a_held_spare_question_is_used_when_the_round_hits_its_time_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 하 여분 문제를 중 자리에 비워 뒀는데 중 자리가 시간 상한까지 답을 받지 못함: 그 자리는
    # 끝나지 않아 자리가 끝날 때 다시 받기(guarded)가 돌지 않음. 세트를 끝낼 때 도는 자리를
    # 기다리지 않고 보관한 문제를 받음(take_reserve(final=True), Codex 3차 재리뷰 #300)
    monkeypatch.setattr(generate, "WORKERS", 8)
    monkeypatch.setattr(generate, "EXTRA", 0.5)
    monkeypatch.setattr(generate, "SEC_PER_QUESTION", 0.2)
    monkeypatch.setattr(generate, "HARD_SEC_PER_QUESTION", 0.5)
    monkeypatch.setattr(generate, "MAX_ROUNDS", 1)  # 다음 판 없이 첫 판 상한에 끝냄
    monkeypatch.setattr(generate, "page_types", lambda text, korean, extra=(): ["정의", "특징"])
    monkeypatch.setattr(generate.levels, "level_mix", lambda n, usable, stats: {"하": 1, "중": 1})
    was_held = threading.Event()
    real_held = generate.levels.held

    def held(*a: Any, **k: Any) -> bool:
        out = real_held(*a, **k)
        if out:
            was_held.set()
        return out

    monkeypatch.setattr(generate.levels, "held", held)
    release = threading.Event()  # 특징 초안은 세트를 돌려준 뒤에야 옴
    one_page = job(size=2)
    one_page["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1 + "\n" + PAGE2}]
    start = time.monotonic()
    try:
        result = make(concurrent_llm("특징", release), one_page)
    finally:
        release.set()
    join_threads("quiz-slot")
    assert was_held.is_set(), "하 여분 문제를 비워 두지 않음"
    assert time.monotonic() - start < 3
    assert kinds_of(result) == [("정의", "하"), ("정의", "하")]


@pytest.mark.usefixtures("mixed_levels")
def test_a_held_question_clashing_with_one_taken_later_is_dropped(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 하 1 · 중 2: 하 여분 문제(개념 C)를 중 자리에 비워 둔 사이 중 자리가 같은 개념 C의 특징
    # 문제를 받고, 다른 중 자리는 실패. 보관한 문제를 다시 받을 때 겹침을 다시 봐 버림: 받으면 한
    # 세트에 개념 C를 두 번 물음(Codex 3차 재리뷰 #300). 판이 하나뿐이라 2/3문제로 끝남
    monkeypatch.setattr(generate, "WORKERS", 8)
    monkeypatch.setattr(generate, "EXTRA", 0.5)  # 3문제에 자리 3 + 여분 2(하 · 중)
    monkeypatch.setattr(generate, "MAX_ROUNDS", 1)
    monkeypatch.setattr(generate, "page_types", lambda text, korean, extra=(): ["정의", "특징"])
    monkeypatch.setattr(generate.levels, "level_mix", lambda n, usable, stats: {"하": 1, "중": 2})
    gate = threading.Event()
    kept: list[str] = []
    real_replace = generate.replace

    def keep(obj: Any, **k: Any) -> Any:
        if isinstance(obj, generate.Made) and not k:  # accept가 보관하는 사본(개념 C)
            assert obj.concept is not None
            kept.append(obj.concept)
            gate.set()
        return real_replace(obj, **k)

    monkeypatch.setattr(generate, "replace", keep)

    def pick(names: list[str]) -> str | None:
        # 첫 특징 초안만 보관한 개념으로, 나머지는 탈락
        if kept and kept[0] not in handed_feature:
            handed_feature.append(kept[0])
            return kept[0]
        return None

    handed_feature: list[str] = []
    one_page = job(size=3)
    one_page["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1 + "\n" + PAGE2}]
    llm = concurrent_llm("특징", gate, fail_after=True, pick=pick)
    with pytest.raises(generate.NoQuestionsError, match=re.escape("2/3문제만 만듦")):
        make(llm, one_page)
    join_threads("quiz-slot")
    assert len(kept) == 1 and handed_feature == kept
