import copy
import re
import threading
import time
from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import pytest

from app.clients.llm import JsonObject, LlmError, LlmRejectedError, LlmSetupError
from app.core.config import settings
from app.services.quiz import generate, srs
from app.services.quiz.generate import Chunk, PageInfo
from app.services.quiz.review import InputError, seoul_midnight
from tests.worker.test_handlers import run_job

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
    """가짜 LLM이 차례로 답하므로 초안을 하나씩, 여분 없이(동시 실행 · 여분 시험은 따로 바꿈)."""
    monkeypatch.setattr(generate, "WORKERS", 1)
    monkeypatch.setattr(generate, "SPARE", 0)


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


def blocks(user: str) -> list[str]:
    """묶은 검사(CheckAll)의 문제 칸들(문제 i (노트 쪽 p) 아래 글)."""
    return re.split(r"^문제 \d+ \(노트 쪽 \d+\)$", user, flags=re.M)[1:]


def letter_of(block: str, want: str | None) -> str:
    for m in re.finditer(r"^([A-E])\. (.+)$", block, re.M):
        if m.group(2) == want:
            return m.group(1)
    return "없음"


def check_all(
    answer_of: Callable[[str], str | None], sure: Callable[[str], bool] = lambda b: True
) -> Callable[[str], JsonObject]:
    """검사 모델(CheckAll): 문제 칸마다 answer_of가 준 글이 있는 보기를 고름. sure가 거짓이면
    정답은 골랐지만 애매하다고 답함."""

    def check(user: str) -> JsonObject:
        rows = []
        for b in blocks(user):
            said = letter_of(b, answer_of(b))
            ok = said != "없음" and sure(b)
            rows.append({"answer": said, "only_one": ok, "supported": ok})
        return {"results": rows}

    return check


def quiz_from(queue: list[JsonObject | LlmError]) -> Callable[[str], JsonObject | LlmError]:
    def answer(user: str) -> JsonObject | LlmError:
        if not queue:
            raise AssertionError("초안이 모자람")
        return queue.pop(0)

    return answer


def made_answer(made: list[tuple[str, str]]) -> Callable[[str], str | None]:
    """문제 칸의 문제 글 · 제시문(보기 줄 밖)으로 만든 초안을 찾아 그 정답. 여럿이 맞으면 가장
    길게 맞는 것(같으면 나중에 만든 것): 특징 문제의 제시문(용어)은 다른 문제의 보기에도 있음."""

    def answer_of(block: str) -> str | None:
        body = "\n".join(ln for ln in block.split("\n") if not re.match(r"^[A-E]\. ", ln))
        hits = [(len(key), i, a) for i, (key, a) in enumerate(made) if key and key in body]
        return max(hits)[2] if hits else None

    return answer_of


def happy(
    drafts: Sequence[JsonObject | LlmError], sure: Callable[[str], bool] = lambda b: True
) -> ScriptLlm:
    made: list[tuple[str, str]] = []
    queue = list(drafts)

    def quiz(user: str) -> JsonObject | LlmError:
        r = quiz_from(queue)(user)
        if not isinstance(r, LlmError):
            q = r["question"]
            made.append((q["passage"] or q["stem"], q["answer"]))
        return r

    return ScriptLlm({"Quiz": quiz, generate.CHECK_NAME: check_all(made_answer(made), sure)})


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
    # 한 판의 초안은 동시에 만들어 이미 쓴 정답이 없음. 한 쪽의 자리는 그 쪽 개념을 나눠 받음
    assert "이미 정답으로 쓴 것" not in gen[1]
    # 검사는 두 문제를 한 호출로, 쪽 글은 쪽마다 한 번
    (check,) = llm.named(generate.CHECK_NAME)
    assert check.count('<노트 쪽="1">') == 1 and "문제 2 (노트 쪽 2)" in check
    assert dict(llm.models)[generate.CHECK_NAME] == settings.quiz_check_model
    assert "복습용" not in generate.GEN_SYS and "⑦" not in generate.GEN_SYS


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
    # 초안 4개를 하나씩 만듦(WORKERS=1): 첫 초안이 멈춤 신호를 켜서 다음 초안은 부르지 않음
    assert len(llm.named("Quiz")) == 1


def test_every_generation_call_rejected_ends_the_job_without_retry() -> None:
    # 서버가 모두 거절(400 · 413 · 422)하면 다시 해도 같음: 일반 장애로 바꾸지 않음(Codex #264)
    llm = happy([LlmRejectedError("HTTP 413")] * 6)
    with pytest.raises(LlmRejectedError):
        run(llm, job(size=1))


# ---------- input ----------


def test_missing_empty_history_notes_is_accepted() -> None:
    inp = job()
    del inp["notes"]
    assert generate.parse(inp).notes == generate.parse(job()).notes


@pytest.mark.parametrize(
    ("change", "where"),
    [
        (lambda i: i.update(day="2026/11/04"), "input.day"),
        (lambda i: i.update(size=0), "input.size"),
        (lambda i: i.update(notes=None), "input.notes"),
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


def test_the_answer_is_stored_as_the_option_it_matched() -> None:
    # code_check는 띄어쓰기를 무시하고 보기를 찾음: '이질아메바' 정답이 '이질 아메바' 보기로
    # 통과하면 저장된 answer가 choices에 없었음(Codex 리뷰 #94)
    d = copy.deepcopy(GOOD["이질 아메바"])
    d["question"]["answer"] = "이질아메바"

    llm = ScriptLlm(
        {"Quiz": quiz_from([d]), generate.CHECK_NAME: check_all(lambda b: "이질 아메바")}
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


def test_the_time_a_question_ended_decides_even_when_its_answers_are_voided() -> None:
    # #113 1번: 익힌 문제(q7)의 풀이가 무효가 되면 마지막으로 푼 시각이 없어져 멈춘 문제(q5)가
    # 나중으로 보였음. 상태가 바뀐 시각(endedAt)으로 비교해 다 익힌 개념으로 봄
    q5 = stored("q5", "이질 아메바", "이질 아메바", "stopped")
    q7 = stored("q7", "이질 아메바", "이질 아메바", "mastered")
    q5["srs"]["endedAt"] = "2026-11-01T06:00:00Z"
    q7["srs"]["endedAt"] = "2026-11-03T06:00:00Z"
    voided = {**attempt("q7", True, void="문제 오류"), "finishedAt": "2026-11-03T06:00:00Z"}
    wrong = [attempt("q5", False) for _ in range(5)]
    inp = job(
        sets=[{"id": "s1", "materialId": "m1", "questions": [q5, q7]}], attempts=[*wrong, voided]
    )
    g = generate.parse(inp)
    per = generate.history(g.sets, g.attempts, "m1", {"m1": generate.note_pages(g.material)})
    assert (per[1].wrong, per[1].mastered) == (0, 1)
    # 거꾸로 익힌 뒤에 멈췄으면 약한 개념(마지막으로 푼 시각은 같아도)
    q5["srs"]["endedAt"], q7["srs"]["endedAt"] = q7["srs"]["endedAt"], q5["srs"]["endedAt"]
    g = generate.parse(inp)
    per = generate.history(g.sets, g.attempts, "m1", {"m1": generate.note_pages(g.material)})
    assert (per[1].wrong, per[1].mastered) == (5, 0)


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
    return ScriptLlm({"Quiz": quiz, generate.CHECK_NAME: check_all(answer_in)})


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


# ---------- 시험 도우미 ----------

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


# ---------- 서버 모양 검사 (#247) ----------


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
    made: list[tuple[str, str]] = []
    asked: list[list[bool]] = []

    def quiz(user: str) -> JsonObject:
        ty = re.search(r"^문제 유형: (\S+)", user, re.M)
        assert ty
        d = typed_draft(ty.group(1), first_name(user))
        made.append((d["question"]["passage"] or d["question"]["stem"], d["question"]["answer"]))
        return d

    def statements(user: str) -> JsonObject:
        m = re.search(r"이 순서로 만든다: (.+)$", user, re.M)
        assert m
        asked.append(["옳음" in x for x in m.group(1).split(", ")])
        concept = first_name(user)
        # 개념마다 다른 문장(같으면 '이미 있는 문제와 거의 같음')
        st = ["위족으로 운동한다.", "포낭형은 8핵이다.", "적혈구를 먹는다."]
        st = st if concept == "이질 아메바" else [f"{concept}: {x}" for x in FEATURES[concept][:3]]
        made.append((st[0], ", ".join(c for c, w in zip("ㄱㄴㄷ", asked[-1], strict=True) if w)))
        return {
            "question": {
                "concept": concept,
                "statements": st,
                "reasons": ["노트와 같다", "포낭형은 4핵이다", "노트와 같다"],
            }
        }

    return ScriptLlm(
        {
            "Quiz": quiz,
            generate.CHECK_NAME: check_all(made_answer(made)),
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


def test_a_combination_is_built_by_code_and_checked_statement_by_statement() -> None:
    llm = typed_llm()
    slot = generate.Slot(1, "상", "조합", NAMES[:2], PageInfo())
    r = generate.draft_one(llm, slot, PAGE1, [], 2)
    q = r.question
    assert q is not None and r.type == "조합" and r.concept == "이질 아메바"
    assert q["passage"] == "ㄱ. 위족으로 운동한다.\nㄴ. 포낭형은 8핵이다.\nㄷ. 적혈구를 먹는다."
    assert q["options"] == sorted(q["options"], key=generate.combo.COMBOS.index)
    assert q["answer"] in q["options"]
    # 문장 판정까지(검사 모델 풀기는 판마다 한 번에, check_all)
    assert [n for n, _ in llm.calls] == ["Combo", "Verify"]


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


# ---------- 내용이 모자랄 때 (#268 · #512) ----------


def offered_names(llm: ScriptLlm) -> list[str]:
    out = []
    for name, user in llm.calls:
        m = re.search(r"^개념 목록\(이 안에서 고른다\): (.+)$", user, re.M)
        if name == "Quiz" and m:
            out.append(m.group(1))
    return out


# ---------- 거절: 작업 처리기까지(#272) ----------
# 서버가 요청을 거절(400 · 413 · 422)하면 다시 보내도 같음: 작업을 다시 넣지 않고 바로 실패.
# 생성뿐 아니라 검사 호출만 모두 거절된 경우도. 거절과 다른 장애가 섞이면 다시 넣음


def refused(_: str) -> JsonObject | LlmError:
    return LlmRejectedError("HTTP 413")


def one_page_job() -> JsonObject:
    inp = job(size=1)
    inp["material"]["pages"] = [{"pageNo": 1, "ocrText": PAGE1}]
    return inp


def test_quiz_generation_all_rejected_fails_without_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    llm = happy([LlmRejectedError("HTTP 413")] * 6)
    doc = run_job(monkeypatch, llm, one_page_job(), generate.TYPE)
    assert (doc["status"], doc["attempts"]) == ("failed", 1)
    assert doc["error"].startswith("AI가 요청을 거절함")


# ---------- 다 만든 뒤 한 번에 검사 (#512) ----------


def wrong_for(passage: str, llm: ScriptLlm) -> None:
    """이 제시문의 초안은 검사 모델이 다른 답(정답 다음 기호)을 고르게 함."""
    check = llm.answers[generate.CHECK_NAME]

    def answer(user: str) -> JsonObject:
        r = check(user)
        assert not isinstance(r, LlmError)
        for b, row in zip(blocks(user), r["results"], strict=True):
            if passage in b:
                row["answer"] = next(x for x in "ABCDE" if x != row["answer"])
        return r

    llm.answers[generate.CHECK_NAME] = answer


def only_definitions(monkeypatch: pytest.MonkeyPatch) -> None:
    """쪽 유형을 정의 하나로(같은 유형으로 다시 묻는 초안을 만들게)."""
    monkeypatch.setattr(generate, "page_types", lambda *a, **k: ["정의"])


def test_all_drafts_of_a_round_are_checked_in_one_call() -> None:
    llm = happy([GOOD[c] for c in NAMES])
    result, steps = run(llm, job(size=4))
    assert sorted(q["answer"] for q in result["questions"]) == sorted(NAMES)
    assert len(llm.named("Quiz")) == 4 and len(llm.named(generate.CHECK_NAME)) == 1
    # 정답 둘 검사 · 문제마다 풀기 · 2차 풀기는 따로 부르지 않음
    assert {n for n, _ in llm.calls} == {"Quiz", generate.CHECK_NAME}
    assert [v for v, _ in steps if v >= 60] == [60, 70, 100]


def test_a_draft_the_checker_answers_otherwise_is_made_again_once_with_its_problem() -> None:
    llm = happy([GOOD["이질 아메바"], GOOD["대장 아메바"]])
    wrong_for(GOOD["이질 아메바"]["question"]["passage"], llm)
    result, _ = run(llm, page1_job(size=1))
    assert [q["answer"] for q in result["questions"]] == ["대장 아메바"]
    gen = llm.named("Quiz")
    assert len(gen) == 2 and len(llm.named(generate.CHECK_NAME)) == 2
    assert "앞서 만든 문제의 문제점: 검사 탈락(검수자 답 B)" in gen[1]
    assert "문제 유형: 특징" in gen[1]  # 다음 판은 다음 유형으로


def test_a_draft_failing_the_code_check_is_not_sent_to_the_checker() -> None:
    llm = happy([BAD, GOOD["이질 아메바"]])
    result, _ = run(llm, page1_job(size=1))
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바"]
    (check,) = llm.named(generate.CHECK_NAME)  # 첫 판은 검사할 초안이 없어 부르지 않음
    assert "위족으로 운동하는 이질 아메바의 특징" not in check
    assert "앞서 만든 문제의 문제점: 설명에 정답 용어 노출" in llm.named("Quiz")[1]


def test_there_are_at_most_two_rounds_and_a_wrong_answer_is_never_used() -> None:
    llm = happy([GOOD["이질 아메바"], GOOD["대장 아메바"], GOOD["람블편모충"]])
    wrong_for(GOOD["이질 아메바"]["question"]["passage"], llm)
    wrong_for(GOOD["대장 아메바"]["question"]["passage"], llm)
    with pytest.raises(generate.NoQuestionsError, match=r"만든 문제가 없음\(검사 탈락"):
        run(llm, page1_job(size=1))
    assert len(llm.named("Quiz")) == 2  # 셋째 초안은 만들지 않음


def test_an_unsure_draft_fills_the_set_when_the_second_round_fails() -> None:
    # 정답은 맞혔지만 애매한 초안은 남겨 두었다가 다음 판도 모자라면 씀
    unsure = GOOD["이질 아메바"]["question"]["passage"]
    llm = happy([GOOD["이질 아메바"], GOOD["대장 아메바"]], sure=lambda b: unsure not in b)
    wrong_for(GOOD["대장 아메바"]["question"]["passage"], llm)
    result, _ = run(llm, page1_job(size=1))
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바"]
    assert result["failed"] == []


def test_an_unsure_draft_is_not_used_when_the_second_round_passes() -> None:
    unsure = GOOD["이질 아메바"]["question"]["passage"]
    llm = happy([GOOD["이질 아메바"], GOOD["대장 아메바"]], sure=lambda b: unsure not in b)
    result, _ = run(llm, page1_job(size=1))
    assert [q["answer"] for q in result["questions"]] == ["대장 아메바"]


def test_a_concept_may_be_asked_twice_from_another_angle() -> None:
    # #512 전에는 한 개념 한 문제: 개념이 하나뿐인 쪽은 두 번째 자리를 채우지 못했음
    inp = page1_job(size=2)
    inp["material"]["concepts"] = ["이질 아메바"]
    llm = happy([typed_draft("정의", "이질 아메바"), typed_draft("특징", "이질 아메바")])
    result, _ = run(llm, inp)
    assert [(q["type"], q["conceptTags"]) for q in result["questions"]] == [
        ("정의", ["이질 아메바"]),
        ("특징", ["이질 아메바"]),
    ]
    assert len(llm.named("Quiz")) == 2 and len(llm.named(generate.CHECK_NAME)) == 1


def test_the_same_answer_with_the_same_type_is_kept_aside_and_used_only_when_short(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    only_definitions(monkeypatch)
    inp = page1_job(size=2)
    inp["material"]["concepts"] = ["이질 아메바"]
    again = draft("이질 아메바", "적혈구를 먹으며 위족으로 움직이는 근족충류 원충이다")
    llm = happy([GOOD["이질 아메바"], again, BAD])
    result, _ = run(llm, inp)
    assert [q["passage"] for q in result["questions"]] == [
        GOOD["이질 아메바"]["question"]["passage"],
        again["question"]["passage"],
    ]
    # 다음 판에 그 자리를 다시 만들어 봤고(BAD는 코드 검사 탈락) 모자라 남겨 둔 초안을 씀
    gen = llm.named("Quiz")
    assert len(gen) == 3 and generate.SAME_TYPE_ANSWER in gen[2]


def test_a_near_same_draft_is_never_used() -> None:
    copied = stored("q1", "이질 아메바", "이질 아메바")
    copied["passage"] = GOOD["이질 아메바"]["question"]["passage"]
    inp = page1_job(size=1, sets=[{"id": "s1", "materialId": "m1", "questions": [copied]}])
    llm = happy([GOOD["이질 아메바"], GOOD["이질 아메바"]])
    with pytest.raises(generate.NoQuestionsError, match="거의 같음"):
        run(llm, inp)
    assert llm.named(generate.CHECK_NAME) == []


def test_spare_drafts_fill_the_set_without_a_second_round(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(generate, "SPARE", 0.4)  # 2문제에 여분 1개
    llm = happy([GOOD["이질 아메바"], GOOD["람블편모충"], GOOD["대장 아메바"]])
    wrong_for(GOOD["람블편모충"]["question"]["passage"], llm)
    result, _ = run(llm, job(size=2))
    assert sorted(q["answer"] for q in result["questions"]) == ["대장 아메바", "이질 아메바"]
    assert len(llm.named("Quiz")) == 3 and len(llm.named(generate.CHECK_NAME)) == 1


def test_a_check_call_failing_once_is_sent_again() -> None:
    llm = happy([GOOD["이질 아메바"]])
    check = llm.answers[generate.CHECK_NAME]
    calls = iter([LlmError("응답 없음"), None])
    llm.answers[generate.CHECK_NAME] = lambda u: next(calls) or check(u)
    result, _ = run(llm, page1_job(size=1))
    assert len(result["questions"]) == 1 and len(llm.named(generate.CHECK_NAME)) == 2


def test_a_bad_check_answer_shape_is_sent_again() -> None:
    llm = happy([GOOD["이질 아메바"]])
    check = llm.answers[generate.CHECK_NAME]
    shapes: Any = iter([{"results": []}, None])
    llm.answers[generate.CHECK_NAME] = lambda u: next(shapes) or check(u)
    result, _ = run(llm, page1_job(size=1))
    assert len(result["questions"]) == 1 and len(llm.named(generate.CHECK_NAME)) == 2


def test_a_check_call_failing_twice_in_the_first_round_retries_the_job() -> None:
    llm = happy([GOOD["이질 아메바"]])
    llm.answers[generate.CHECK_NAME] = lambda u: LlmError("응답 없음")
    with pytest.raises(LlmError):
        run(llm, page1_job(size=1))
    assert len(llm.named(generate.CHECK_NAME)) == 2


def test_a_check_outage_after_questions_were_taken_fills_from_what_was_kept() -> None:
    # 문제를 받은 뒤의 장애: 받은 문제를 버리고 작업을 처음부터 다시 돌리지 않음
    unsure = GOOD["람블편모충"]["question"]["passage"]
    llm = happy(
        [GOOD["이질 아메바"], GOOD["람블편모충"], GOOD["질편모충"]], sure=lambda b: unsure not in b
    )
    check = llm.answers[generate.CHECK_NAME]
    llm.answers[generate.CHECK_NAME] = lambda u: (
        check(u) if len(llm.named(generate.CHECK_NAME)) == 1 else LlmError("응답 없음")
    )
    result, _ = run(llm, job(size=2))
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바", "람블편모충"]


def test_a_pregen_taken_over_makes_the_next_round_with_the_fast_types(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    extras: list[tuple[str, ...]] = []
    real = generate.page_types

    def spy(text: str, korean: bool, extra: tuple[str, ...] = ()) -> list[str]:
        extras.append(extra)
        return real(text, korean, extra)

    monkeypatch.setattr(generate, "page_types", spy)
    llm = happy([BAD, GOOD["이질 아메바"]])
    make(llm, page1_job(size=1), mode=generate.STABLE, hurry=lambda: True)
    # 첫 판은 안정적 모드 유형, 이어받은 뒤 둘째 판은 빠른 모드 유형
    assert extras[-2:] == [generate.STABLE.extra, ()]


def test_quiz_checks_all_rejected_fail_without_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    llm = happy([GOOD["이질 아메바"]])
    llm.answers[generate.CHECK_NAME] = refused
    doc = run_job(monkeypatch, llm, one_page_job(), generate.TYPE)
    assert (doc["status"], doc["attempts"]) == ("failed", 1)
    assert len(llm.named(generate.CHECK_NAME)) == 1  # 거절은 다시 보내지 않음


def test_many_drafts_are_checked_in_batches(monkeypatch: pytest.MonkeyPatch) -> None:
    # 30문제 · 긴 노트를 한 호출에 넣으면 학교 LLM 문맥을 넘음(/code-review #512)
    monkeypatch.setattr(generate, "CHECK_BATCH", 1)
    llm = happy([GOOD["이질 아메바"], GOOD["람블편모충"]])
    result, _ = run(llm, job(size=2))
    assert len(result["questions"]) == 2
    checks = llm.named(generate.CHECK_NAME)
    assert len(checks) == 2 and all(c.count("문제 1 (") == 1 for c in checks)
    assert '<노트 쪽="2">' not in checks[0] and '<노트 쪽="1">' not in checks[1]


def test_long_page_text_starts_a_new_batch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(generate, "CHECK_CHARS", len(PAGE1) + 1)
    llm = happy([GOOD["이질 아메바"], GOOD["람블편모충"]])
    run(llm, job(size=2))
    assert len(llm.named(generate.CHECK_NAME)) == 2


def test_a_draft_the_checker_finds_no_answer_for_is_never_used() -> None:
    # '없음'은 다른 답과 같이 봄: 정답이 틀렸을 수 있어 모자라도 채우지 않음
    nothing = GOOD["이질 아메바"]["question"]["passage"]
    llm = happy([GOOD["이질 아메바"], GOOD["대장 아메바"]])
    check = llm.answers[generate.CHECK_NAME]

    def answer(user: str) -> JsonObject:
        r = check(user)
        assert not isinstance(r, LlmError)
        for b, row in zip(blocks(user), r["results"], strict=True):
            if nothing in b:
                row.update(answer="없음", only_one=False, supported=False)
        return r

    llm.answers[generate.CHECK_NAME] = answer
    wrong_for(GOOD["대장 아메바"]["question"]["passage"], llm)
    with pytest.raises(generate.NoQuestionsError, match="검수자 답 없음"):
        run(llm, page1_job(size=1))


def test_a_second_round_check_outage_fills_from_kept_drafts_alone() -> None:
    # 첫 판이 애매한 초안뿐이어도 둘째 판 장애로 작업을 처음부터 다시 돌리지 않음
    unsure = GOOD["이질 아메바"]["question"]["passage"]
    llm = happy([GOOD["이질 아메바"], GOOD["대장 아메바"]], sure=lambda b: unsure not in b)
    check = llm.answers[generate.CHECK_NAME]
    llm.answers[generate.CHECK_NAME] = lambda u: (
        check(u) if len(llm.named(generate.CHECK_NAME)) == 1 else LlmError("응답 없음")
    )
    result, _ = run(llm, page1_job(size=1))
    assert [q["answer"] for q in result["questions"]] == ["이질 아메바"]


def test_a_draft_filled_from_kept_is_not_reported_as_not_made(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    only_definitions(monkeypatch)
    inp = page1_job(size=3)
    inp["material"]["concepts"] = ["이질 아메바"]
    again = draft("이질 아메바", "적혈구를 먹으며 위족으로 움직이는 근족충류 원충이다")
    llm = happy([GOOD["이질 아메바"], again, BAD, BAD, BAD])
    with pytest.raises(generate.NoQuestionsError) as e:
        run(llm, inp)
    assert str(e.value).startswith("2/3문제만 만듦")
    assert generate.SAME_TYPE_ANSWER not in str(e.value)
