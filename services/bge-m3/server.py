"""Operator-owned loopback BGE-M3 service for Parilka retrieval.

Endpoints (all bounded by contract.py):
  GET  /health  -> liveness + model/contract identity
  POST /encode  -> one pass: dense 1024 + learned sparse token weights
  POST /rerank  -> bounded ColBERT late-interaction scores, no vectors

ML imports are lazy: the process starts and serves /health even before the
model is loaded, and contract validation never requires torch. The server
binds loopback only and accepts no credential, path, or model override from
requests: the model id is fixed to BAAI/bge-m3.

FlagEmbedding v1.3.4 API notes this gateway is pinned to:
  * BGEM3FlagModel.encode(..., return_dense=..., return_sparse=...,
    return_colbert_vecs=...) -> dict with keys dense_vecs, lexical_weights,
    colbert_vecs;
  * lexical_weights entries are dicts keyed by *stringified numeric token
    ids* (the model does idx = str(idx)); keys are numeric ids, never decoded
    token text, so they must be parsed as integers, not mapped through the
    tokenizer;
  * official late-interaction scoring is model.colbert_score(q, p) =
    sum over query tokens of max similarity / query token count; this gateway
    implements exactly that formula.
"""

from __future__ import annotations

import argparse
import collections.abc
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import contract


class ModelLoadError(RuntimeError):
    """The fixed model could not be loaded; every later call fails the same."""


class ModelInferenceError(RuntimeError):
    """The loaded model produced an unusable or malformed result."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Loopback BGE-M3 encode/rerank service for Parilka.",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument(
        "--batch-size",
        type=int,
        default=16,
        help="Internal model batch size; request batch is bounded by contract.",
    )
    parser.add_argument(
        "--max-length",
        type=int,
        default=8192,
        help="BGE-M3 tokenizer window; inputs are char-bounded by contract.",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    args = parser.parse_args()
    if not is_loopback_host(args.host):
        parser.error(
            "--host must bind a loopback address; the BGE-M3 service is "
            "never exposed beyond this machine."
        )
    if not (1 <= args.port <= 65535):
        parser.error("--port must be within 1-65535.")
    if not (1 <= args.batch_size <= contract.MAX_BATCH_TEXTS):
        parser.error(
            f"--batch-size must be within 1-{contract.MAX_BATCH_TEXTS}."
        )
    if not (1 <= args.max_length <= 8192):
        parser.error("--max-length must be within 1-8192.")
    return args


def is_loopback_host(host: str) -> bool:
    normalized = host.strip().lower()
    if normalized in {"localhost", "127.0.0.1", "::1"}:
        return True
    if normalized.startswith("[") and normalized.endswith("]"):
        normalized = normalized[1:-1]
    if normalized in {"::1", "0:0:0:0:0:0:0:1"}:
        return True
    if normalized == "localhost" or normalized.endswith(".localhost"):
        return True
    parts = normalized.split(".")
    return len(parts) == 4 and all(part.isdigit() for part in parts) and parts[0] == "127"


class BgeModelGateway:
    """Lazy FlagEmbedding wrapper. Loads the fixed model exactly once.

    Model calls are serialized by one inference lock: ThreadingHTTPServer must
    never drive concurrent encode/rerank calls against the same model, and a
    stored load error makes every later request fail with a stable
    ModelLoadError instead of touching a half-built object.
    """

    def __init__(self, batch_size: int, max_length: int) -> None:
        self._batch_size = batch_size
        self._max_length = max_length
        self._load_lock = threading.Lock()
        self._infer_lock = threading.Lock()
        self._model = None
        self._load_error: str | None = None

    @property
    def ready(self) -> bool:
        return self._model is not None

    @property
    def load_error(self) -> str | None:
        return self._load_error

    def ensure_loaded(self) -> None:
        with self._load_lock:
            if self._model is not None:
                return
            if self._load_error is not None:
                raise ModelLoadError("BGE-M3 model is unavailable")
            try:
                # Lazy import keeps contract tests torch-free.
                from FlagEmbedding import BGEM3FlagModel

                self._model = BGEM3FlagModel(
                    contract.MODEL_ID,
                    use_fp16=True,
                )
            except Exception as exc:  # pragma: no cover - needs model files
                logging.exception("BGE-M3 model load failed")
                self._load_error = f"{type(exc).__name__}: {exc}"
                raise ModelLoadError("BGE-M3 model load failed") from exc

    def encode(self, texts: list[str]) -> list[dict]:
        self.ensure_loaded()
        with self._infer_lock:
            try:
                output = self._model.encode(
                    texts,
                    batch_size=self._batch_size,
                    max_length=self._max_length,
                    return_dense=True,
                    return_sparse=True,
                    return_colbert_vecs=False,
                )
            except (ModelLoadError, ModelInferenceError):
                raise
            except Exception as exc:
                logging.exception("BGE-M3 encode failed")
                raise ModelInferenceError("BGE-M3 encode failed") from exc
        if not isinstance(output, dict):
            raise ModelInferenceError(
                "BGE-M3 encode returned a malformed result"
            )
        try:
            # Real FlagEmbedding v1.3.4 returns dense_vecs as an np.ndarray
            # of shape N x 1024 and lexical_weights as a list of dicts with
            # np scalar weights; both are accepted as sized/indexable
            # containers and converted to plain Python numbers below.
            dense_rows = _as_indexable(
                output.get("dense_vecs"), "dense_vecs"
            )
            sparse_rows = _as_indexable(
                output.get("lexical_weights"), "lexical_weights"
            )
            if len(dense_rows) != len(texts) or len(sparse_rows) != len(texts):
                raise ModelInferenceError("BGE-M3 encode returned a malformed shape")
            results: list[dict] = []
            for index in range(len(texts)):
                # Values are emitted unrounded: rounding could zero a tiny
                # positive learned weight that the storage contract requires
                # to stay strictly positive.
                dense = contract.bounded_dense_vector(
                    _row_to_list(dense_rows[index])
                )
                sparse = self._sparse_terms(sparse_rows[index], index)
                results.append(
                    {
                        "dense": dense,
                        "sparse": [
                            {"token_id": token_id, "weight": weight}
                            for token_id, weight in sparse
                        ],
                    }
                )
            return results
        except ModelInferenceError:
            raise
        except contract.ContractError as exc:
            raise ModelInferenceError("BGE-M3 encode output is invalid") from exc
        except Exception as exc:
            # Any conversion/shape failure while reading model output is a
            # model failure, never a client error. KeyboardInterrupt and
            # SystemExit are BaseException and are not caught here.
            raise ModelInferenceError("BGE-M3 encode output is invalid") from exc

    def _sparse_terms(self, weights: object, index: int) -> list[tuple[int, float]]:
        """Parses FlagEmbedding lexical weights into bounded (token_id, weight).

        Keys are numeric token ids: FlagEmbedding stores them via
        idx = str(idx), so an int key or a decimal string key is accepted as
        an id directly. Anything else fails closed; keys are never routed
        through the tokenizer as decoded text.
        """
        if not isinstance(weights, dict):
            raise ModelInferenceError(
                f"BGE-M3 sparse weights of result {index} must be a mapping"
            )
        pairs: list[tuple[int, float]] = []
        for key, weight in weights.items():
            token_id = self._parse_token_id(key)
            # Model weights arrive as numpy scalars; .item() converts them to
            # plain Python numbers before the strict contract validation.
            try:
                scalar = weight.item() if hasattr(weight, "item") else weight
            except Exception as exc:
                raise ModelInferenceError(
                    f"BGE-M3 sparse weight of result {index} is not convertible"
                ) from exc
            if isinstance(scalar, bool) or not isinstance(scalar, (int, float)):
                raise ModelInferenceError(
                    f"BGE-M3 sparse weight of result {index} is not a number"
                )
            pairs.append((token_id, float(scalar)))
        try:
            return contract.bounded_sparse_terms(pairs)
        except contract.ContractError as exc:
            raise ModelInferenceError(
                f"BGE-M3 sparse terms of result {index} are invalid"
            ) from exc

    def _parse_token_id(self, key: object) -> int:
        if isinstance(key, bool):
            raise ModelInferenceError("BGE-M3 sparse term key is not a token id")
        if isinstance(key, int):
            token_id = key
        elif isinstance(key, str) and key.isascii() and key.isdigit():
            token_id = int(key)
        else:
            raise ModelInferenceError("BGE-M3 sparse term key is not a numeric token id")
        if token_id < 0 or token_id > contract.MAX_SPARSE_TOKEN_ID:
            raise ModelInferenceError("BGE-M3 sparse token id is out of bounds")
        return token_id

    def rerank(self, query: str, candidates: list[str]) -> list[float]:
        self.ensure_loaded()
        with self._infer_lock:
            try:
                output = self._model.encode(
                    [query, *candidates],
                    batch_size=self._batch_size,
                    max_length=self._max_length,
                    return_dense=False,
                    return_sparse=False,
                    return_colbert_vecs=True,
                )
            except (ModelLoadError, ModelInferenceError):
                raise
            except Exception as exc:
                logging.exception("BGE-M3 rerank encode failed")
                raise ModelInferenceError("BGE-M3 rerank failed") from exc
        if not isinstance(output, dict):
            raise ModelInferenceError(
                "BGE-M3 rerank returned a malformed result"
            )
        try:
            # colbert_vecs is a list of per-text np.ndarray rows.
            vectors = _as_indexable(output.get("colbert_vecs"), "colbert_vecs")
            if len(vectors) != len(candidates) + 1:
                raise ModelInferenceError("BGE-M3 rerank returned a malformed shape")
            query_vectors = vectors[0]
            scores = [
                self._colbert_score(query_vectors, candidate_vectors)
                for candidate_vectors in vectors[1:]
            ]
            return contract.bounded_scores(scores, len(candidates))
        except ModelInferenceError:
            raise
        except contract.ContractError as exc:
            raise ModelInferenceError("BGE-M3 rerank output is invalid") from exc
        except Exception as exc:
            # Any conversion/shape failure while reading model output is a
            # model failure, never a client error. KeyboardInterrupt and
            # SystemExit are BaseException and are not caught here.
            raise ModelInferenceError("BGE-M3 rerank output is invalid") from exc

    @staticmethod
    def _colbert_score(query_vectors, candidate_vectors) -> float:
        """Official BGEM3FlagModel.colbert_score formula.

        For every query token take the max similarity across candidate
        tokens, sum those maxima, and divide by the query token count.
        Torch and numpy fast paths keep production latency bounded; the
        pure-Python fallback exists for stdlib-only test environments.
        """
        if hasattr(query_vectors, "detach") or hasattr(
            candidate_vectors, "detach"
        ):
            return _colbert_score_torch(query_vectors, candidate_vectors)
        try:
            return _colbert_score_numpy(query_vectors, candidate_vectors)
        except ImportError:
            return _colbert_score_python(query_vectors, candidate_vectors)


def _as_indexable(value: object, label: str):
    """Accepts lists/tuples and ndarray-like sized/indexable containers.

    Strings, bytes, and mappings also expose __len__/__getitem__ but are
    never valid model output containers here; they fail closed.
    """
    if isinstance(value, (list, tuple)):
        return value
    if isinstance(value, (str, bytes, bytearray)):
        raise ModelInferenceError(
            f"BGE-M3 {label} output is not a valid container"
        )
    if isinstance(value, collections.abc.Mapping):
        raise ModelInferenceError(
            f"BGE-M3 {label} output is not a valid container"
        )
    if hasattr(value, "__len__") and hasattr(value, "__getitem__"):
        return value
    raise ModelInferenceError(f"BGE-M3 {label} output is not indexable")


def _row_to_list(row: object) -> list:
    """Converts an ndarray-like dense row to plain Python numbers."""
    try:
        converted = row.tolist() if hasattr(row, "tolist") else row
    except Exception as exc:
        raise ModelInferenceError(
            "BGE-M3 dense row is not convertible"
        ) from exc
    if isinstance(converted, (list, tuple)):
        return list(converted)
    raise ModelInferenceError("BGE-M3 dense row is not convertible")


def _colbert_score_torch(query_vectors, candidate_vectors) -> float:
    try:
        import torch
    except ImportError as exc:  # pragma: no cover - ships with FlagEmbedding
        raise ModelInferenceError("torch is required for tensor scoring") from exc
    try:
        query = (
            query_vectors
            if hasattr(query_vectors, "detach")
            else torch.as_tensor(query_vectors)
        ).to(dtype=torch.float32)
        candidate = (
            candidate_vectors
            if hasattr(candidate_vectors, "detach")
            else torch.as_tensor(candidate_vectors)
        ).to(dtype=torch.float32)
        if (
            query.dim() != 2
            or candidate.dim() != 2
            or query.shape[0] == 0
            or candidate.shape[0] == 0
            or query.shape[1] != candidate.shape[1]
        ):
            raise ModelInferenceError(
                "colbert vectors must be non-empty 2-D rows with matching dims"
            )
        token_scores = query @ candidate.transpose(0, 1)
        scores, _ = token_scores.max(dim=-1)
        return float(scores.sum() / query.shape[0])
    except ModelInferenceError:
        raise
    except Exception as exc:
        raise ModelInferenceError("colbert scoring failed") from exc


def _colbert_score_numpy(query_vectors, candidate_vectors) -> float:
    import numpy as np

    try:
        query = _as_numpy_matrix(np, query_vectors)
        candidate = _as_numpy_matrix(np, candidate_vectors)
        if (
            query.shape[0] == 0
            or candidate.shape[0] == 0
            or query.shape[1] != candidate.shape[1]
        ):
            raise ModelInferenceError(
                "colbert vectors must be non-empty with matching dims"
            )
        token_scores = query @ candidate.transpose()
        per_query_token = token_scores.max(axis=1)
        return float(per_query_token.sum() / query.shape[0])
    except ModelInferenceError:
        raise
    except Exception as exc:
        raise ModelInferenceError("colbert scoring failed") from exc


def _as_numpy_matrix(np, vectors):
    if hasattr(vectors, "detach"):  # torch tensor
        try:
            import torch  # noqa: PLC0415 - lazy by design
        except ImportError as exc:  # pragma: no cover
            raise ModelInferenceError("torch tensors require torch") from exc
        matrix = vectors.detach().to(dtype=torch.float32, device="cpu").numpy()
    else:
        try:
            matrix = np.asarray(vectors, dtype=np.float32)
        except (TypeError, ValueError):
            # asarray rejects containers whose elements don't expose the
            # buffer/sequence protocol (e.g. stdlib stand-ins like NdRow).
            # Real ndarray / tensor fast paths are unaffected — they
            # succeed on the first try.
            try:
                rows = []
                for row in vectors:
                    if hasattr(row, "tolist"):
                        rows.append(row.tolist())
                    else:
                        rows.append([float(v) for v in row])
                matrix = np.asarray(rows, dtype=np.float32)
            except Exception as exc:
                raise ModelInferenceError(
                    "colbert vectors are not numeric"
                ) from exc
    if matrix.ndim != 2 or not np.isfinite(matrix).all():
        raise ModelInferenceError("colbert vectors must be finite 2-D rows")
    return matrix


def _colbert_score_python(query_vectors, candidate_vectors) -> float:
    import math

    query = _coerce_rows(query_vectors)
    candidate = _coerce_rows(candidate_vectors)
    if not query or not candidate:
        raise ModelInferenceError("colbert vectors must be non-empty rows")
    dims = len(query[0])
    if dims == 0:
        raise ModelInferenceError("colbert vectors must have columns")
    total = 0.0
    for query_row in query:
        best = None
        for candidate_row in candidate:
            if len(candidate_row) != dims:
                raise ModelInferenceError(
                    "colbert vectors must have matching dims"
                )
            similarity = sum(
                a * b for a, b in zip(query_row, candidate_row)
            )
            if best is None or similarity > best:
                best = similarity
        if best is None or not math.isfinite(best):
            raise ModelInferenceError("colbert scores must be finite")
        total += best
    return total / len(query)


def _coerce_rows(vectors) -> list[list[float]]:
    import math

    try:
        if hasattr(vectors, "detach"):
            try:
                import torch  # noqa: PLC0415 - lazy by design
            except ImportError as exc:  # pragma: no cover
                raise ModelInferenceError("torch tensors require torch") from exc
            vectors = vectors.detach().to(dtype=torch.float32, device="cpu").tolist()
        elif hasattr(vectors, "tolist"):
            vectors = vectors.tolist()
        rows: list[list[float]] = []
        for row in vectors:
            if hasattr(row, "tolist"):
                row = row.tolist()
            values: list[float] = []
            for value in row:
                number = float(value)
                if not math.isfinite(number):
                    raise ModelInferenceError("colbert vectors must be finite")
                values.append(number)
            rows.append(values)
        return rows
    except ModelInferenceError:
        raise
    except Exception as exc:
        raise ModelInferenceError("colbert vectors are not numeric") from exc


class Handler(BaseHTTPRequestHandler):
    gateway: BgeModelGateway
    server_version = "ParilkaBgeM3/1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        logging.info("%s %s", self.address_string(), fmt % args)

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        declared = self.headers.get("Content-Length")
        if declared is None or not declared.isdigit():
            raise contract.ContractError("Content-Length is required")
        length = int(declared)
        if length > contract.MAX_REQUEST_BYTES:
            raise contract.ContractError(
                f"request body exceeds {contract.MAX_REQUEST_BYTES} bytes"
            )
        return self.rfile.read(length)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self._send_json(404, {"error": "not_found"})
            return
        payload = {
            "status": "ok" if self.gateway.ready else "loading",
            "model": contract.MODEL_ID,
            "contract": contract.CONTRACT,
            "capabilities": {
                "dense": True,
                "sparse": True,
                "rerank": True,
            },
        }
        if self.gateway.load_error:
            payload["status"] = "error"
            payload["load_error_type"] = type_of_load_error(
                self.gateway.load_error
            )
        self._send_json(200, payload)

    def do_POST(self) -> None:  # noqa: N802
        try:
            raw = self._read_body()
            payload = contract.parse_json_body(raw)
            if self.path == "/encode":
                texts = contract.parse_encode_request(payload)
                results = self.gateway.encode(texts)
                self._send_json(
                    200,
                    {
                        "model": contract.MODEL_ID,
                        "contract": contract.CONTRACT,
                        "results": results,
                    },
                )
                return
            if self.path == "/rerank":
                query, candidates = contract.parse_rerank_request(payload)
                scores = self.gateway.rerank(query, candidates)
                self._send_json(
                    200,
                    {
                        "model": contract.MODEL_ID,
                        "contract": contract.CONTRACT,
                        "scores": scores,
                    },
                )
                return
            self._send_json(404, {"error": "not_found"})
        except contract.ContractError as exc:
            self._send_json(400, {"error": str(exc)})
        except RuntimeError:
            # Model load/inference failures are stable outward: details stay
            # in the journal only, never in the loopback response body.
            logging.exception("model failure")
            self._send_json(500, {"error": "model_failure"})
        except Exception:
            logging.exception("unexpected failure")
            self._send_json(500, {"error": "internal_failure"})


def type_of_load_error(message: str) -> str:
    return message.split(":", 1)[0][:120]


def main() -> None:
    args = parse_args()
    logging.basicConfig(level=args.log_level)
    gateway = BgeModelGateway(args.batch_size, args.max_length)
    Handler.gateway = gateway
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    logging.info(
        "parilka-bge-m3 listening on %s:%s (model %s, contract %s)",
        args.host,
        args.port,
        contract.MODEL_ID,
        contract.CONTRACT,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:  # pragma: no cover
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
