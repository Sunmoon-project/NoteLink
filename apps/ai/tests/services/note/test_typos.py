import pytest

from app.clients.llm import LlmError
from app.services.note.chunking import split_rows
from app.services.note.models import Chunk, Mark, TypoFix
from app.services.note.terms import TermDict
from app.services.note.typos import (
    apply_fixes,
    candidates,
    find_typos,
    parse_picks,
    split_word,
)
from tests.fakes import FakeLlm
from tests.services.note.helpers import row

TERMS = TermDict(
    ["포낭형", "영양형", "이핵아메바", "이질아메바", "항원", "원충류", "후편모", "포자소체", "두절"]
)


def chunk(*texts: str, page: int = 1, marks: list[Mark] | None = None) -> Chunk:
    (c,) = split_rows([row(t, page=page, lid=i) for i, t in enumerate(texts, 1)])
    if marks is not None:
        c["emphasis"] = {"has": bool(marks), "marks": marks}
    return c


@pytest.mark.parametrize(
    ("token", "parts"),
    [
        ("B창원", ("B", "창원", "")),  # 앞 영문은 그대로 (B창원 → B항원)
        ("[?]포남형", ("[?]", "포남형", "")),
        ("원충류중", ("", "원충류", "중")),
        ("후편모도", ("", "후편모", "도")),  # '후편'+'모도'로 자르지 않음
        ("포자소체(혈류", ("", "포자소체", "(혈류")),
        ("영양형이", ("", "영양형", "이")),
        ("ABC", ("ABC", "", "")),
    ],
)
def test_split_word_keeps_prefix_and_tail(token: str, parts: tuple[str, str, str]) -> None:
    assert split_word(token, TERMS) == parts


def test_candidates_skip_terms_common_words_and_non_nouns() -> None:
    c = chunk("1. 이질 아메바", "- 포남형 : 성숙 신속한 영양형")
    words = {x["word"]: x["options"] for x in candidates(c, TERMS)}
    assert words == {"포남형": ["포낭형"]}


def test_two_words_become_one_candidate_when_joined_is_closer() -> None:
    c = chunk("4. 이책 아메바")
    (x,) = candidates(c, TERMS)
    assert x["word"] == "이책 아메바" and x["options"][0] == "이핵아메바"


@pytest.mark.parametrize("line", ["4. 이책 [?]아메바", "4. 이책  아메바"])
def test_two_word_candidate_keeps_the_original_text(line: str) -> None:
    c = chunk(line)
    (x,) = candidates(c, TERMS)
    assert x["word"] in c["text"]  # 원문 그대로라야 바꿀 수 있음
    (out,) = apply_fixes([c], [fix(x["word"], "이핵아메바")])
    assert out["text"] == "4. 이핵아메바"


def test_two_words_with_other_prefix_are_not_joined() -> None:
    assert all(x["word"] != "이책 (아메바" for x in candidates(chunk("4. 이책 (아메바"), TERMS))


def test_find_typos_one_call_per_page_and_status() -> None:
    p1, p2 = chunk("- 포남형 : 인체 감염형", page=1), chunk("- 두직이 있다", page=2)
    p2["order"] = 2
    llm = FakeLlm(
        {"note_typos": [{"picks": [{"id": 1, "choice": 1}]}, {"picks": [{"id": 1, "choice": 1}]}]}
    )
    fixes = find_typos(llm, "gemma-4-26b", [p1, p2], TERMS)
    assert len(llm.named("note_typos")) == 2  # 쪽마다 1번
    assert "<note>" in llm.calls[0].user and "포남형 → 0) 그대로 / 1) 포낭형" in llm.calls[0].user
    by = {f["word"]: f for f in fixes}
    assert by["포남형"]["status"] == "auto"  # 같은 글자 수 · 유사도 0.88
    assert by["두직"]["status"] == "review"  # 유사도 0.6 → 바로 적용하지 않음


def test_no_candidates_means_no_llm_call() -> None:
    llm = FakeLlm()
    assert find_typos(llm, "m", [chunk("1. 이질 아메바", "영양형")], TERMS) == []
    assert llm.calls == []


def cand(word: str, *options: str) -> list[dict[str, object]]:
    return [{"id": 1, "order": 1, "word": word, "options": list(options)}]


@pytest.mark.parametrize(
    "picks",
    [
        [{"id": 1, "choice": 0}],  # 그대로
        [{"id": 1, "choice": 9}],  # 범위 밖
        [{"id": 1, "choice": True}],  # 불리언
        [{"id": 1, "choice": "1"}],  # 문자열
        [{"id": 7, "choice": 1}],  # 없는 물음
        ["1"],
    ],
)
def test_bad_or_zero_picks_are_ignored(picks: list[object]) -> None:
    assert parse_picks({"picks": picks}, cand("포남형", "포낭형")) == []  # type: ignore[arg-type]


def test_missing_picks_raise() -> None:
    with pytest.raises(LlmError):
        parse_picks({"fixes": []}, cand("포남형", "포낭형"))  # type: ignore[arg-type]


def test_different_syllable_count_is_never_auto() -> None:
    (f,) = parse_picks({"picks": [{"id": 1, "choice": 1}]}, cand("생식세", "생식모세포"))  # type: ignore[arg-type]
    assert f["status"] == "review"


def fix(word: str, term: str, status: str = "auto") -> TypoFix:
    return {"order": 1, "word": word, "term": term, "sim": 0.9, "status": status}  # type: ignore[typeddict-item]


def test_apply_fixes_keeps_prefix_tail_and_drops_unsure_mark() -> None:
    c = chunk("- B창원 : D-galactose", "- [?]포남형이 있다")
    (out,) = apply_fixes([c], [fix("창원", "항원"), fix("포남형", "포낭형")])
    assert out["text"] == "- B항원 : D-galactose\n- 포낭형이 있다"
    assert out["uncertainCount"] == 0
    assert [f["word"] for f in out.get("fixes", [])] == ["창원", "포남형"]


def test_apply_fixes_only_whole_words() -> None:
    c = chunk("- 창원 검사", "- 창원은 B창원과 다름", "- 창원시 · 대창원")
    (out,) = apply_fixes([c], [fix("창원", "항원")])
    assert out["text"] == "- 항원 검사\n- 항원은 B항원과 다름\n- 창원시 · 대창원"


def test_apply_fixes_also_fix_title_and_path() -> None:
    cs = split_rows(
        [row(t, lid=i) for i, t in enumerate(["Ⅰ. 포남형", "1. 세부 포남형", "- 내용"], 1)]
    )
    (out,) = apply_fixes(cs, [fix("포남형", "포낭형")])
    assert (out["title"], out["path"]) == ("1. 세부 포낭형", ["Ⅰ. 포낭형"])
    assert out["text"].startswith("1. 세부 포낭형")


def test_review_fixes_are_kept_but_not_applied() -> None:
    c = chunk("- 두직이 있다")
    (out,) = apply_fixes([c], [fix("두직", "두절", "review")])
    assert out["text"] == "- 두직이 있다" and out.get("fixes", [])[0]["status"] == "review"


def test_apply_fixes_moves_marks_after_a_shorter_replacement() -> None:
    text = "4. 이책 아메바 ★ 중요"
    star = text.index("★")
    c = chunk(text, marks=[{"kind": "symbol", "start": star, "end": star + 1}])
    (out,) = apply_fixes([c], [fix("이책 아메바", "이핵아메바")])
    (m,) = out["emphasis"]["marks"]
    assert out["text"][m["start"] : m["end"]] == "★"


@pytest.mark.parametrize(
    ("word", "want"),
    [
        ("[?]포남형", "포낭형"),  # [?]까지 떼며 짧아져도 낱말 강조가 사라지지 않음
        ("포남형", "포낭형"),
        ("남", "포낭형"),  # 낱말 일부 강조는 고친 낱말 전체로
        ("형이 있다", "포낭형이 있다"),  # 낱말 안에서 시작한 강조도 낱말 처음부터
    ],
)
def test_marks_inside_a_fixed_word_follow_the_new_word(word: str, want: str) -> None:
    text = "- [?]포남형이 있다"
    at = text.index(word)
    c = chunk(text, marks=[{"kind": "highlight", "start": at, "end": at + len(word)}])
    (out,) = apply_fixes([c], [fix("포남형", "포낭형")])
    (m,) = out["emphasis"]["marks"]
    assert out["text"] == "- 포낭형이 있다" and out["text"][m["start"] : m["end"]] == want


def test_chunks_without_fixes_are_unchanged() -> None:
    c = chunk("1. 이질 아메바")
    (out,) = apply_fixes([c], [])
    assert "fixes" not in out and out["text"] == c["text"]
