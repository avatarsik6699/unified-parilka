"""Pure wire contract for the Parilka local BGE-M3 service.

This module must stay importable without torch/FlagEmbedding installed: it
only validates bounded JSON shapes shared with the TypeScript client in
`src/vector/bge-client.ts`. Every bound here is mirrored there; bump both
together and rotate `CONTRACT` when the wire shape changes.
"""

from __future__ import annotations

import json

CONTRACT = "bge-m3-v1"
MODEL_ID = "BAAI/bge-m3"
DENSE_DIMENSIONS = 1024

MAX_BATCH_TEXTS = 64
MAX_CHARS_PER_TEXT = 8000
MAX_QUERY_CHARS = 2000
MAX_RERANK_CANDIDATES = 32
MAX_SPARSE_TERMS = 1024
MAX_SPARSE_TOKEN_ID = 300_000
MAX_SPARSE_WEIGHT = 1000.0
MAX_REQUEST_BYTES = 8 * 1024 * 1024


class ContractError(ValueError):
    """Bounded request/response contract violation. Never carries secrets."""


def parse_json_body(raw: bytes) -> object:
    if len(raw) > MAX_REQUEST_BYTES:
        raise ContractError(
            f"request body exceeds {MAX_REQUEST_BYTES} bytes"
        )
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError(f"invalid JSON body: {exc}") from exc


def _require_string(payload: object, field: str, max_chars: int) -> str:
    if not isinstance(payload, dict):
        raise ContractError("request body must be a JSON object")
    value = payload.get(field)
    if not isinstance(value, str) or len(value) == 0:
        raise ContractError(f"{field} must be a non-empty string")
    if len(value) > max_chars:
        raise ContractError(f"{field} exceeds {max_chars} characters")
    return value


def parse_encode_request(payload: object) -> list[str]:
    if not isinstance(payload, dict):
        raise ContractError("request body must be a JSON object")
    contract = payload.get("contract")
    if contract != CONTRACT:
        raise ContractError(
            f"unsupported contract {contract!r}; expected {CONTRACT}"
        )
    texts = payload.get("texts")
    if not isinstance(texts, list) or len(texts) == 0:
        raise ContractError("texts must be a non-empty array")
    if len(texts) > MAX_BATCH_TEXTS:
        raise ContractError(
            f"texts batch is limited to {MAX_BATCH_TEXTS} entries"
        )
    for index, text in enumerate(texts):
        if not isinstance(text, str) or len(text) == 0:
            raise ContractError(f"texts[{index}] must be a non-empty string")
        if len(text) > MAX_CHARS_PER_TEXT:
            raise ContractError(
                f"texts[{index}] exceeds {MAX_CHARS_PER_TEXT} characters"
            )
    return list(texts)


def parse_rerank_request(payload: object) -> tuple[str, list[str]]:
    if not isinstance(payload, dict):
        raise ContractError("request body must be a JSON object")
    contract = payload.get("contract")
    if contract != CONTRACT:
        raise ContractError(
            f"unsupported contract {contract!r}; expected {CONTRACT}"
        )
    query = _require_string(payload, "query", MAX_QUERY_CHARS)
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or len(candidates) == 0:
        raise ContractError("candidates must be a non-empty array")
    if len(candidates) > MAX_RERANK_CANDIDATES:
        raise ContractError(
            f"candidates are limited to {MAX_RERANK_CANDIDATES} entries"
        )
    for index, text in enumerate(candidates):
        if not isinstance(text, str) or len(text) == 0:
            raise ContractError(
                f"candidates[{index}] must be a non-empty string"
            )
        if len(text) > MAX_CHARS_PER_TEXT:
            raise ContractError(
                f"candidates[{index}] exceeds {MAX_CHARS_PER_TEXT} characters"
            )
    return query, list(candidates)


def bounded_sparse_terms(pairs) -> list[tuple[int, float]]:
    """Validates learned sparse terms and collapses them deterministically.

    Duplicate token ids keep the maximum weight; the top MAX_SPARSE_TERMS
    entries survive ordered by (weight desc, token id asc) and are returned
    sorted by token id ascending so downstream SQL rows are stable.
    """
    best: dict[int, float] = {}
    for index, pair in enumerate(pairs):
        if not isinstance(pair, (tuple, list)) or len(pair) != 2:
            raise ContractError(f"sparse term {index} must be [token_id, weight]")
        token_id, weight = pair
        if (
            not isinstance(token_id, int)
            or isinstance(token_id, bool)
            or token_id < 0
            or token_id > MAX_SPARSE_TOKEN_ID
        ):
            raise ContractError(
                f"sparse term {index} token_id must be an integer in "
                f"[0, {MAX_SPARSE_TOKEN_ID}]"
            )
        if (
            not isinstance(weight, (int, float))
            or isinstance(weight, bool)
            or weight != weight  # NaN guard
            or weight <= 0
            or weight > MAX_SPARSE_WEIGHT
        ):
            raise ContractError(
                f"sparse term {index} weight must be finite and in "
                f"(0, {MAX_SPARSE_WEIGHT}]"
            )
        weight = float(weight)
        if token_id not in best or weight > best[token_id]:
            best[token_id] = weight
    ranked = sorted(best.items(), key=lambda item: (-item[1], item[0]))
    return sorted(ranked[:MAX_SPARSE_TERMS], key=lambda item: item[0])


def bounded_dense_vector(values: object) -> list[float]:
    if not isinstance(values, list) or len(values) != DENSE_DIMENSIONS:
        raise ContractError(
            f"dense vector must carry exactly {DENSE_DIMENSIONS} values"
        )
    out: list[float] = []
    for value in values:
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or value != value
            or value in (float("inf"), float("-inf"))
        ):
            raise ContractError("dense vector values must be finite numbers")
        out.append(float(value))
    return out


def bounded_scores(values: object, expected: int) -> list[float]:
    if not isinstance(values, list) or len(values) != expected:
        raise ContractError(f"scores must carry exactly {expected} values")
    out: list[float] = []
    for value in values:
        if (
            not isinstance(value, (int, float))
            or isinstance(value, bool)
            or value != value
            or value in (float("inf"), float("-inf"))
        ):
            raise ContractError("scores must be finite numbers")
        out.append(float(value))
    return out
