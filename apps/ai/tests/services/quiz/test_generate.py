import copy
import re
from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Any

import pytest

from app.clients.llm import JsonObject, LlmError
from app.services.quiz import generate
from app.services.quiz.generate import Chunk, PageInfo
from app.services.quiz.review import InputError

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
        # 지식 검사(정답)는 true, 오답 보기 검사는 false
        value = user.rsplit("\n", 1)[-1].split(": ", 1)[-1]
        return {"natural": bool(made) and value == made[-1]}

    return ScriptLlm(
        {
            "Quiz": quiz,
            "Natural": natural_fn or nat,
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
    llm = happy(drafts, natural_fn=lambda u: {"natural": True})
    result, _ = run(llm, job(size=1))
    assert result["questions"] == []
    assert "오답 보기: " in result["failed"][0]["why"][0]  # 정의 · 특징 모두 같은 검사로 걸림


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
