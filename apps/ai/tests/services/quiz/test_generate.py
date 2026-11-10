import copy
import re
import threading
import time
import types
from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import pytest

from app.clients.llm import JsonObject, LlmError, LlmRejectedError, LlmSetupError
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
NAMES = ["이질 아메바", "대장 아메바", "람블편모충", "질편모충"]


@pytest.fixture(autouse=True)
def one_slot_at_a_time(monkeypatch: pytest.MonkeyPatch) -> None:
    """가짜 LLM이 차례로 답하므로 자리를 하나씩, 여분 자리 없이(동시 실행 시험은 따로 바꿈)."""
    monkeypatch.setattr(generate, "WORKERS", 1)
    monkeypatch.setattr(generate, "EXTRA", 0)


@dataclass
class ScriptLlm:
    """이름마다 user 글을 보고 답하는 가짜 LLM. 답 대신 LlmError를 돌려주면 던집니다."""

    answers: dict[str, Callable[[str], JsonObject | LlmError]]
    calls: list[tuple[str, str]] = field(default_factory=list)

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
    result, _ = run(llm, inp)
    gen = llm.named("Quiz")
    assert "고른다): 대장 아메바\n" in gen[1]  # 이미 물은 이질 아메바는 목록에서 뺌
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바", "대장 아메바"]
    assert result["failed"] == [{"pageNo": 1, "why": ["물을 개념이 남지 않음"]}]


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
    result, _ = run(llm, job(size=1))
    assert result["questions"] == []
    assert result["failed"][0]["why"] == ["검사 탈락(검수자 답 E)"]


def test_wrong_options_that_also_fit_are_caught() -> None:
    drafts = [GOOD["이질 아메바"]] * 2 + [GOOD["람블편모충"]] * 2
    llm = happy(drafts, natural_fn=lambda u: {"natural": [True] * len(candidates(u))})
    result, _ = run(llm, job(size=1))
    assert result["questions"] == []
    assert "오답 보기: " in result["failed"][0]["why"][0]  # 정의 · 특징 모두 같은 검사로 걸림


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


def test_a_note_without_text_makes_no_questions() -> None:
    inp = job()
    inp["material"]["pages"] = [
        {"pageNo": 1, "ocrText": "[?]흐린 줄"},
        {"pageNo": 2, "ocrText": None},
    ]
    result, _ = run(ScriptLlm({}), inp)
    assert (result["questions"], result["pages"], result["failed"]) == ([], [], [])


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
    result, _ = run(llm, inp)
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바", "대장 아메바"]


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
    result, _ = run(llm, job(size=1))
    assert result["questions"] == []
    assert result["failed"] == [{"pageNo": 1, "why": [generate.TIMEOUT]}]
    assert len(llm.named("Quiz")) == 1  # 두 번째 유형 · 다른 쪽으로 넘기지 않음


def test_a_pregen_gets_a_longer_time_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    # 미리 만들기는 LLM 차례를 양보하므로 상한이 PATIENT배: 같은 느린 호출에도 문제를 만듦(#138)
    now = [0.0]
    monkeypatch.setattr(generate, "_clock", lambda: now[0])

    def made(patient: bool) -> JsonObject:
        bad = draft("이질 아메바", "위족으로 운동하는 이질 아메바의 특징")  # 설명에 정답 용어
        llm = happy([bad, GOOD["이질 아메바"]])
        quiz = llm.answers["Quiz"]

        def slow(user: str) -> Any:
            now[0] += generate.SEC_PER_QUESTION * 2  # 보통 상한(1문제 20초)은 지나지만 10배 안
            return quiz(user)

        llm.answers["Quiz"] = slow
        return generate.run(llm, job(size=1), lambda v, step=None: None, patient=patient)

    assert [q["answer"] for q in made(patient=True)["questions"]] == ["이질 아메바"]
    # 보통 상한이면 첫 초안이 걸린 뒤 다시 만들지 않음
    assert made(patient=False)["questions"] == []


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
    try:
        result, _ = run(llm, job(size=2))
    finally:
        release.set()
    assert time.monotonic() - start < 3
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바"]
    assert result["failed"] == [{"pageNo": 2, "why": [generate.TIMEOUT]}]
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
    try:
        result, _ = run(parallel_llm(quiz2), inp)
    finally:
        release2.set()
    assert len(result["questions"]) == 1
    assert len(result["failed"]) == 2  # 도는 자리 1 + 시작하지 못한 자리 1


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
