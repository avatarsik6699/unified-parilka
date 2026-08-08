"""Exact Telegram runtime footer and vision cap hooks for the parilka profile.

Native Hermes ``display.runtime_footer`` stays disabled (it shows %, not our
format); this module appends the exact footer for tracked group turns and
caps vision analysis to 6 images per Telegram agent turn (attachment cap
ledger + pre_llm budget bridge + pre_tool_call gate). All tracking state is
thread-safe, bounded (TTL + max entries) and free of raw message data.

Registered by :func:`register` on top of the existing parilka_chat hooks.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any, Callable, Dict, Mapping, Optional

PARILKA_PROFILE = "parilka"
CHAT_ID_ENV = "PARILKA_TELEGRAM_CHAT_ID"

FOOTER_MAX_TOKENS = 1048576
VISION_MAX_IMAGES = 6
VISION_TOOL_NAME = "vision_analyze"
_VISION_BLOCK_MESSAGE = "Лимит анализа изображений: максимум 6 за один ход."

# Bounded per-session tracking: stale entries are pruned by TTL, the oldest
# entries are evicted beyond the cap. Only metadata is stored — never text.
_STATE_TTL_SECONDS = 3600.0
_STATE_MAX_ENTRIES = 128
_VISION_TTL_SECONDS = 3600.0
_VISION_MAX_ENTRIES = 128

_lock = threading.Lock()
_state: Dict[str, Dict[str, Any]] = {}
# Pending kept-image counts from the pre_gateway cap, keyed
# "chat_id:message_id" — metadata only, consumed by the pre_llm bridge.
_vision_ledger: Dict[str, Dict[str, Any]] = {}
# Per-turn vision budgets keyed "session_id:turn_id" (fallback sequence when
# turn_id is missing) — metadata only.
_vision_budget: Dict[str, Dict[str, Any]] = {}
# Per-session fallback turn sequence when turn_id is missing.
_turn_seq: Dict[str, Dict[str, Any]] = {}


def _prune_store(store: Dict[str, Dict[str, Any]], now: float) -> None:
    """Drop stale entries (TTL) and evict the oldest beyond the cap."""
    stale = [
        key
        for key, entry in store.items()
        if now - entry["ts"] > _VISION_TTL_SECONDS
    ]
    for key in stale:
        store.pop(key, None)
    overflow = len(store) - _VISION_MAX_ENTRIES
    if overflow > 0:
        oldest = sorted(store.items(), key=lambda item: item[1]["ts"])[:overflow]
        for key, _ in oldest:
            store.pop(key, None)


def _valid_message_id(value: Any) -> Optional[int]:
    """Positive int (or digit string) within the Telegram safe id range."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        msg_id = value
    elif isinstance(value, str) and value.strip():
        try:
            msg_id = int(value.strip())
        except (TypeError, ValueError):
            return None
    else:
        return None
    if msg_id < 1 or msg_id > 9007199254740991:
        return None
    return msg_id


def _turn_key(session_id: Any, turn_id: Any, now: float, *, allocate: bool) -> str:
    """Budget key: session_id+turn_id when present, else a per-session
    monotonic fallback sequence so distinct turns never share a budget."""
    session = str(session_id)
    if turn_id is not None and str(turn_id):
        return f"{session}:{turn_id}"
    entry = _turn_seq.get(session)
    seq = entry["n"] if entry is not None else 0
    if allocate:
        _turn_seq[session] = {"n": seq + 1, "ts": now}
        return f"{session}:fb:{seq + 1}"
    return f"{session}:fb:{seq}"


def _compact_tokens(count: int) -> str:
    """Compact a token count: 38100 -> 38.1k, 1048576 -> 1.0m."""
    if count >= 1_000_000:
        return f"{count / 1_000_000:.1f}m"
    if count >= 1_000:
        return f"{count / 1_000:.1f}k"
    return str(count)


def _format_elapsed(seconds: float) -> str:
    """Elapsed wall time: 30 -> "30с", 63 -> "1м 3с"."""
    total = int(seconds)
    minutes, secs = divmod(total, 60)
    if minutes:
        return f"{minutes}м {secs}с"
    return f"{secs}с"


def _bare_model(model: Any) -> str:
    """Strip any provider prefix: "provider/model" -> "model"."""
    return str(model).rsplit("/", 1)[-1]


def _footer(model: Any, used: int, tool_calls: int, elapsed: float) -> str:
    return (
        f"{_bare_model(model)} 🧠 · "
        f"{_compact_tokens(used)}/{_compact_tokens(FOOTER_MAX_TOKENS)} · "
        f"{tool_calls} tool calls · {_format_elapsed(elapsed)}"
    )


class FooterTracker:
    """Per-session footer tracking for valid Parilka Telegram group turns.

    pre_llm_call starts (and resets) tracking, post_api_request records the
    LATEST ``prompt_tokens`` only, post_tool_call counts every emitted call,
    transform_llm_output appends the exact footer and pops the state.
    """

    def __init__(
        self,
        profile: str,
        get_session_env: Callable[[], Dict[str, str]],
        assert_telegram_group: Callable[[Dict[str, str]], int],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._profile = profile
        self._get_session_env = get_session_env
        self._assert_telegram_group = assert_telegram_group
        self._clock = clock

    def _valid_session(self, session_id: Any) -> bool:
        if self._profile != PARILKA_PROFILE or session_id is None:
            return False
        try:
            env = self._get_session_env()
            self._assert_telegram_group(env)
        except Exception:
            return False
        return True

    def _prune(self, now: float) -> None:
        stale = [
            sid
            for sid, entry in _state.items()
            if now - entry["start"] > _STATE_TTL_SECONDS
        ]
        for sid in stale:
            _state.pop(sid, None)
        overflow = len(_state) - _STATE_MAX_ENTRIES
        if overflow > 0:
            oldest = sorted(_state.items(), key=lambda item: item[1]["start"])[
                :overflow
            ]
            for sid, _ in oldest:
                _state.pop(sid, None)

    def pre_llm_call(self, **kwargs: Any) -> None:
        """Reset per-session tracking when a valid Telegram group turn starts."""
        session_id = kwargs.get("session_id")
        if not self._valid_session(session_id):
            return
        now = self._clock()
        with _lock:
            _state[session_id] = {"start": now, "used": 0, "tool_calls": 0}
            self._prune(now)

    def post_api_request(self, **kwargs: Any) -> None:
        """Record the LATEST prompt_tokens only — never a sum or accumulation.

        ``prompt_tokens`` already includes cache exactly once; input/cache/
        output are not combined and API calls are not accumulated.
        """
        session_id = kwargs.get("session_id")
        usage = kwargs.get("usage")
        prompt_tokens = (
            usage.get("prompt_tokens") if isinstance(usage, Mapping) else None
        )
        # Canonical prompt_tokens is a nonnegative int — bool is not a token
        # count and negatives are invalid.
        if (
            not isinstance(prompt_tokens, int)
            or isinstance(prompt_tokens, bool)
            or prompt_tokens < 0
        ):
            return
        with _lock:
            entry = _state.get(session_id)
            if entry is not None:
                entry["used"] = prompt_tokens

    def post_tool_call(self, **kwargs: Any) -> None:
        """Count every emitted tool call, including blocked/error ones."""
        session_id = kwargs.get("session_id")
        with _lock:
            entry = _state.get(session_id)
            if entry is not None:
                entry["tool_calls"] += 1

    def transform_llm_output(self, **kwargs: Any) -> Any:
        """Append the exact footer to tracked Telegram turns, then pop state."""
        session_id = kwargs.get("session_id")
        response_text = kwargs.get("response_text")
        if session_id is None or not isinstance(response_text, str):
            return response_text
        with _lock:
            entry = _state.pop(session_id, None)
        if entry is None:
            return response_text
        elapsed = self._clock() - entry["start"]
        footer = _footer(
            kwargs.get("model", ""), entry["used"], entry["tool_calls"], elapsed
        )
        return f"{response_text}\n\n{footer}"


def make_vision_cap(
    profile: str,
    env_getter: Callable[[str], Optional[str]] = os.environ.get,
    chat_id_env: str = CHAT_ID_ENV,
    clock: Callable[[], float] = time.monotonic,
) -> Callable[[Any], Optional[Dict[str, str]]]:
    """Factory for the pre_gateway_dispatch vision cap with captured profile.

    Keeps the first VISION_MAX_IMAGES image attachments of a single merged
    Telegram MessageEvent (source platform telegram — the Platform enum is
    normalized to its value — exact allowed chat id, chat_type group),
    preserving order and every non-image attachment. When images are dropped
    the hook returns the gateway rewrite shape ``{"action": "rewrite",
    "text": ...}`` — the original text plus a short system note (no media
    paths). At or below the cap it returns None without touching the event.

    The kept image count (even when nothing was dropped) is recorded into
    the bounded ``_vision_ledger`` under the allowed chat id + message id
    key — metadata only, no texts, URLs or paths; invalid or missing
    message ids are not recorded.

    The cap limits vision ANALYSIS only: the Telegram adapter download has
    already happened by pre_gateway_dispatch time.
    """
    allowed_chat_id = (env_getter(chat_id_env) or "").strip()

    def pre_gateway_dispatch(
        event: Any, **kwargs: Any
    ) -> Optional[Dict[str, str]]:
        if profile != PARILKA_PROFILE or not allowed_chat_id:
            return None
        source = getattr(event, "source", None)
        if source is None:
            return None
        # SessionSource.platform is the Platform enum (value "telegram"), not
        # a raw string — normalize so both the enum and plain stubs match.
        platform = getattr(source, "platform", None)
        platform = getattr(platform, "value", platform)
        if platform != "telegram":
            return None
        if str(getattr(source, "chat_id", "")) != allowed_chat_id:
            return None
        if getattr(source, "chat_type", None) != "group":
            return None

        urls = getattr(event, "media_urls", None)
        types = getattr(event, "media_types", None)
        if (
            not isinstance(urls, list)
            or not isinstance(types, list)
            or len(urls) != len(types)
        ):
            return None

        message_type = getattr(getattr(event, "message_type", None), "value", None)

        def _is_image(mime: Any) -> bool:
            if isinstance(mime, str) and mime:
                return mime.startswith("image/")
            return message_type == "photo"

        kept_urls: list = []
        kept_types: list = []
        images_total = 0
        images_kept = 0
        for url, mime in zip(urls, types):
            if _is_image(mime):
                images_total += 1
                if images_kept >= VISION_MAX_IMAGES:
                    continue
                images_kept += 1
            kept_urls.append(url)
            kept_types.append(mime)

        if images_total > 0:
            msg_id = _valid_message_id(getattr(event, "message_id", None))
            if msg_id is not None:
                now = clock()
                with _lock:
                    _vision_ledger[f"{allowed_chat_id}:{msg_id}"] = {
                        "count": images_kept,
                        "ts": now,
                    }
                    _prune_store(_vision_ledger, now)

        if images_kept == images_total:
            return None

        event.media_urls = kept_urls
        event.media_types = kept_types
        original = event.text if isinstance(event.text, str) else ""
        note = (
            f"\n\n[система: для анализа взято {images_kept} "
            f"из {images_total} изображений]"
        )
        return {"action": "rewrite", "text": f"{original}{note}"}

    return pre_gateway_dispatch


def make_vision_budget_bridge(
    profile: str,
    get_session_env: Callable[[], Dict[str, str]],
    assert_telegram_group: Callable[[Dict[str, str]], int],
    clock: Callable[[], float] = time.monotonic,
) -> Callable[..., None]:
    """Factory for the pre_llm vision budget bridge with captured context.

    For a valid Parilka Telegram group turn, atomically moves the pending
    kept-image count recorded by the pre_gateway_dispatch cap for the
    message that started this turn into a fresh budget for the current
    session/turn; a turn without pending attachments starts at zero. Foreign
    profiles and invalid sessions are a no-op.
    """

    def pre_llm_call(**kwargs: Any) -> None:
        session_id = kwargs.get("session_id")
        if profile != PARILKA_PROFILE or session_id is None:
            return
        try:
            env = get_session_env()
            message_id = assert_telegram_group(env)
        except Exception:
            return
        now = clock()
        with _lock:
            pending = _vision_ledger.pop(
                f"{env.get('chat_id', '')}:{message_id}", None
            )
            turn_key = _turn_key(
                session_id, kwargs.get("turn_id"), now, allocate=True
            )
            _vision_budget[turn_key] = {
                "attach": pending["count"] if pending else 0,
                "used": 0,
                "ts": now,
            }
            _prune_store(_vision_ledger, now)
            _prune_store(_vision_budget, now)
            _prune_store(_turn_seq, now)

    return pre_llm_call


def make_vision_budget_gate(
    profile: str,
    get_session_env: Callable[[], Dict[str, str]],
    assert_telegram_group: Callable[[Dict[str, str]], int],
    clock: Callable[[], float] = time.monotonic,
) -> Callable[..., Optional[Dict[str, str]]]:
    """Factory for the pre_tool_call vision budget gate with captured context.

    Handles only ``vision_analyze``. For a valid Parilka Telegram group
    session the gate allows attempts atomically while attachments + allowed
    calls stay below VISION_MAX_IMAGES; every allowed attempt counts even if
    the tool later fails. The next attempts are blocked with a stable short
    Russian message (no data or paths). Other tools and foreign
    profiles/sessions are a no-op.
    """

    def pre_tool_call(**kwargs: Any) -> Optional[Dict[str, str]]:
        if str(kwargs.get("tool_name", "")) != VISION_TOOL_NAME:
            return None
        session_id = kwargs.get("session_id")
        if profile != PARILKA_PROFILE or session_id is None:
            return None
        try:
            env = get_session_env()
            assert_telegram_group(env)
        except Exception:
            return None
        now = clock()
        with _lock:
            turn_key = _turn_key(
                session_id, kwargs.get("turn_id"), now, allocate=False
            )
            entry = _vision_budget.get(turn_key)
            if entry is None:
                entry = {"attach": 0, "used": 0, "ts": now}
                _vision_budget[turn_key] = entry
                _prune_store(_vision_budget, now)
            if entry["attach"] + entry["used"] >= VISION_MAX_IMAGES:
                return {"action": "block", "message": _VISION_BLOCK_MESSAGE}
            entry["used"] += 1
            return None

    return pre_tool_call


def register(
    ctx: Any,
    *,
    get_session_env: Callable[[], Dict[str, str]],
    assert_telegram_group: Callable[[Dict[str, str]], int],
    env_getter: Callable[[str], Optional[str]] = os.environ.get,
    clock: Callable[[], float] = time.monotonic,
) -> None:
    """Register the runtime footer, vision cap and vision budget hooks."""
    profile = getattr(ctx, "profile_name", None)
    tracker = FooterTracker(profile, get_session_env, assert_telegram_group, clock)
    ctx.register_hook("pre_llm_call", tracker.pre_llm_call)
    ctx.register_hook(
        "pre_llm_call",
        make_vision_budget_bridge(
            profile, get_session_env, assert_telegram_group, clock
        ),
    )
    ctx.register_hook("post_api_request", tracker.post_api_request)
    ctx.register_hook("post_tool_call", tracker.post_tool_call)
    ctx.register_hook("transform_llm_output", tracker.transform_llm_output)
    ctx.register_hook(
        "pre_gateway_dispatch", make_vision_cap(profile, env_getter, clock=clock)
    )
    ctx.register_hook(
        "pre_tool_call",
        make_vision_budget_gate(
            profile, get_session_env, assert_telegram_group, clock
        ),
    )
