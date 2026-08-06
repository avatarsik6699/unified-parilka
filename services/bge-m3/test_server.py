"""Stdlib-only gateway tests: no torch, no model files, no network.

A fake model stands in for BGEM3FlagModel so the tests pin the exact
FlagEmbedding v1.3.4 API surface the gateway depends on:
  * encode(..., return_colbert_vecs=...) (not return_colbert);
  * lexical_weights keyed by numeric token ids (int or decimal strings);
  * ColBERT scoring formula sum(per-query-token max) / query token count.
"""

from __future__ import annotations

import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import contract
import server


class FakeModel:
    """Records encode calls and returns canned BGE-M3-shaped outputs."""

    def __init__(self, outputs: list[dict]):
        self.outputs = outputs
        self.calls: list[dict] = []
        self.locked_during_call: list[bool] = []
        self.gateway: server.BgeModelGateway | None = None

    def encode(self, sentences, **kwargs):
        self.calls.append({"sentences": list(sentences), "kwargs": kwargs})
        if self.gateway is not None:
            self.locked_during_call.append(
                self.gateway._infer_lock.locked()
            )
        return self.outputs.pop(0)


def make_gateway(outputs: list[dict]) -> tuple[server.BgeModelGateway, FakeModel]:
    gateway = server.BgeModelGateway(batch_size=4, max_length=512)
    fake = FakeModel(outputs)
    fake.gateway = gateway
    gateway._model = fake
    gateway._load_error = None
    return gateway, fake


def dense_row(dim: int = contract.DENSE_DIMENSIONS) -> list[float]:
    return [0.0] * (dim - 1) + [1.0]


class EncodeApiTest(unittest.TestCase):
    def test_encode_uses_exact_v134_kwargs_and_numeric_ids(self):
        gateway, fake = make_gateway(
            [
                {
                    "dense_vecs": [dense_row()],
                    "lexical_weights": [
                        {"12345": 0.5, 7: 0.25, "99": 0.125}
                    ],
                }
            ]
        )
        results = gateway.encode(["привет"])
        kwargs = fake.calls[0]["kwargs"]
        self.assertTrue(kwargs["return_dense"])
        self.assertTrue(kwargs["return_sparse"])
        self.assertFalse(kwargs["return_colbert_vecs"])
        self.assertNotIn("return_colbert", kwargs)
        self.assertEqual(
            [(t["token_id"], t["weight"]) for t in results[0]["sparse"]],
            [(7, 0.25), (99, 0.125), (12345, 0.5)],
        )

    def test_non_numeric_sparse_key_fails_closed(self):
        gateway, _ = make_gateway(
            [
                {
                    "dense_vecs": [dense_row()],
                    "lexical_weights": [{"▁релиз": 0.5}],
                }
            ]
        )
        with self.assertRaises(RuntimeError):
            gateway.encode(["текст"])

    def test_out_of_bounds_token_id_fails_closed(self):
        gateway, _ = make_gateway(
            [
                {
                    "dense_vecs": [dense_row()],
                    "lexical_weights": [
                        {str(contract.MAX_SPARSE_TOKEN_ID + 1): 0.5}
                    ],
                }
            ]
        )
        with self.assertRaises(RuntimeError):
            gateway.encode(["текст"])

    def test_encode_is_serialized_by_the_inference_lock(self):
        gateway, fake = make_gateway(
            [
                {
                    "dense_vecs": [dense_row()],
                    "lexical_weights": [{"1": 0.1}],
                }
            ]
        )
        gateway.encode(["текст"])
        self.assertEqual(fake.locked_during_call, [True])

    def test_stored_load_error_is_a_stable_runtime_failure(self):
        gateway = server.BgeModelGateway(batch_size=1, max_length=8)
        gateway._load_error = "OSError: model files missing"
        for _ in range(2):
            with self.assertRaises(RuntimeError) as caught:
                gateway.encode(["текст"])
            self.assertNotIsInstance(caught.exception, AttributeError)
            self.assertNotIsInstance(caught.exception, ImportError)


class RerankApiTest(unittest.TestCase):
    def test_rerank_uses_colbert_vecs_and_official_formula(self):
        # query tokens: e1=(1,0), e2=(0,1)
        # candidate tokens: (1,0) and (0.5,0.5)
        # max per query token: 1.0 and 0.5 -> (1.0 + 0.5) / 2 = 0.75
        gateway, fake = make_gateway(
            [
                {
                    "colbert_vecs": [
                        [[1.0, 0.0], [0.0, 1.0]],
                        [[1.0, 0.0], [0.5, 0.5]],
                    ]
                }
            ]
        )
        scores = gateway.rerank("запрос", ["кандидат"])
        kwargs = fake.calls[0]["kwargs"]
        self.assertFalse(kwargs["return_dense"])
        self.assertFalse(kwargs["return_sparse"])
        self.assertTrue(kwargs["return_colbert_vecs"])
        self.assertNotIn("return_colbert", kwargs)
        self.assertEqual(len(scores), 1)
        self.assertAlmostEqual(scores[0], 0.75, places=6)

    def test_rerank_normalizes_empty_query_vectors_to_zero(self):
        gateway, _ = make_gateway(
            [
                {
                    "colbert_vecs": [
                        [],
                        [[1.0, 0.0]],
                    ]
                }
            ]
        )
        with self.assertRaises(RuntimeError):
            gateway.rerank("запрос", ["кандидат"])


class HandlerTest(unittest.TestCase):
    def setUp(self):
        self.gateway, self.fake = make_gateway([])
        server.Handler.gateway = self.gateway
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.origin = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        self.thread = threading.Thread(
            target=self.httpd.serve_forever, daemon=True
        )
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    def request(self, path: str, body: object | None = None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            self.origin + path,
            data=data,
            method="GET" if data is None else "POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.loads(error.read().decode())
            finally:
                error.close()

    def test_health_reports_identity(self):
        status, payload = self.request("/health")
        self.assertEqual(status, 200)
        self.assertEqual(payload["model"], contract.MODEL_ID)
        self.assertEqual(payload["contract"], contract.CONTRACT)
        self.assertEqual(payload["status"], "ok")

    def test_encode_response_carries_validated_identity(self):
        self.fake.outputs.append(
            {
                "dense_vecs": [dense_row()],
                "lexical_weights": [{"42": 0.5}],
            }
        )
        status, payload = self.request(
            "/encode",
            {"contract": contract.CONTRACT, "texts": ["текст"]},
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["model"], contract.MODEL_ID)
        self.assertEqual(payload["contract"], contract.CONTRACT)
        self.assertEqual(payload["results"][0]["sparse"][0]["token_id"], 42)

    def test_wrong_contract_rejected(self):
        status, payload = self.request(
            "/encode", {"contract": "other", "texts": ["текст"]}
        )
        self.assertEqual(status, 400)
        self.assertIn("contract", payload["error"])

    def test_model_failure_returns_stable_500_without_details(self):
        def boom(sentences, **kwargs):
            raise ValueError("CUDA secret path /home/x leaked")

        self.fake.encode = boom
        status, payload = self.request(
            "/encode",
            {"contract": contract.CONTRACT, "texts": ["текст"]},
        )
        self.assertEqual(status, 500)
        self.assertEqual(payload, {"error": "model_failure"})

    def test_load_error_gives_stable_500_not_attribute_error(self):
        self.gateway._model = None
        self.gateway._load_error = "OSError: weights missing"
        status, payload = self.request(
            "/encode",
            {"contract": contract.CONTRACT, "texts": ["текст"]},
        )
        self.assertEqual(status, 500)
        self.assertEqual(payload, {"error": "model_failure"})
        health_status, health = self.request("/health")
        self.assertEqual(health_status, 200)
        self.assertEqual(health["status"], "error")
        self.assertEqual(health["load_error_type"], "OSError")

    def test_rerank_endpoint_returns_scores(self):
        self.fake.outputs.append(
            {
                "colbert_vecs": [
                    [[1.0, 0.0]],
                    [[1.0, 0.0]],
                ]
            }
        )
        status, payload = self.request(
            "/rerank",
            {
                "contract": contract.CONTRACT,
                "query": "запрос",
                "candidates": ["кандидат"],
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["scores"], [1.0])


class NdRow:
    """Stdlib stand-in for one np.ndarray row: exposes tolist()."""

    def __init__(self, values):
        self._values = list(values)

    def tolist(self):
        return list(self._values)


class NdArray:
    """Stdlib stand-in for an np.ndarray: sized and indexable."""

    def __init__(self, items):
        self._items = list(items)

    def __len__(self):
        return len(self._items)

    def __getitem__(self, index):
        return self._items[index]


class NpScalar:
    """Stdlib stand-in for a numpy scalar: only .item() yields a number."""

    def __init__(self, value):
        self._value = value

    def item(self):
        return self._value


class RealNumpyShapeTest(unittest.TestCase):
    """Gateway must accept FlagEmbedding v1.3.4 numpy outputs, not just lists."""

    def test_encode_accepts_ndarray_dense_and_scalar_weights(self):
        gateway, fake = make_gateway(
            [
                {
                    "dense_vecs": NdArray([NdRow(dense_row())]),
                    "lexical_weights": [{"12345": NpScalar(0.25)}],
                }
            ]
        )
        results = gateway.encode(["текст"])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["sparse"], [{"token_id": 12345, "weight": 0.25}])
        self.assertTrue(
            all(isinstance(value, float) for value in results[0]["dense"])
        )
        self.assertEqual(results[0]["dense"][-1], 1.0)

    def test_tiny_positive_sparse_weight_is_not_rounded_away(self):
        gateway, _ = make_gateway(
            [
                {
                    "dense_vecs": NdArray([NdRow(dense_row())]),
                    "lexical_weights": [{"7": NpScalar(1e-09)}],
                }
            ]
        )
        results = gateway.encode(["текст"])
        self.assertEqual(results[0]["sparse"][0]["weight"], 1e-09)

    def test_ndarray_colbert_vectors_score_without_lists(self):
        gateway, fake = make_gateway(
            [
                {
                    "colbert_vecs": [
                        NdArray([NdRow([1.0, 0.0]), NdRow([0.0, 1.0])]),
                        NdArray([NdRow([1.0, 0.0]), NdRow([0.5, 0.5])]),
                    ]
                }
            ]
        )
        scores = gateway.rerank("запрос", ["кандидат"])
        self.assertAlmostEqual(scores[0], 0.75, places=6)


class OutputFailureClassificationTest(HandlerTest):
    def test_malformed_dense_values_are_model_failure_not_400(self):
        self.fake.outputs.append(
            {
                "dense_vecs": NdArray([NdRow(["not-a-number"])]),
                "lexical_weights": [{}],
            }
        )
        status, payload = self.request(
            "/encode",
            {"contract": contract.CONTRACT, "texts": ["текст"]},
        )
        self.assertEqual(status, 500)
        self.assertEqual(payload, {"error": "model_failure"})

    def test_out_of_bounds_sparse_token_is_model_failure_not_400(self):
        self.fake.outputs.append(
            {
                "dense_vecs": NdArray([NdRow(dense_row())]),
                "lexical_weights": [
                    {str(contract.MAX_SPARSE_TOKEN_ID + 1): NpScalar(0.5)}
                ],
            }
        )
        status, payload = self.request(
            "/encode",
            {"contract": contract.CONTRACT, "texts": ["текст"]},
        )
        self.assertEqual(status, 500)
        self.assertEqual(payload, {"error": "model_failure"})

    def test_nonfinite_rerank_score_is_model_failure_not_400(self):
        self.fake.outputs.append(
            {"colbert_vecs": [[[1.0, 0.0]], [[1.0, 0.0]]]}
        )
        self.gateway._colbert_score = lambda query, candidate: float("inf")
        status, payload = self.request(
            "/rerank",
            {
                "contract": contract.CONTRACT,
                "query": "запрос",
                "candidates": ["кандидат"],
            },
        )
        self.assertEqual(status, 500)
        self.assertEqual(payload, {"error": "model_failure"})

    def test_client_request_contract_errors_stay_400(self):
        status, payload = self.request(
            "/encode",
            {"contract": "wrong", "texts": ["текст"]},
        )
        self.assertEqual(status, 400)
        self.assertIn("contract", payload["error"])

    def test_throwing_tolist_is_model_failure(self):
        class ThrowingRow:
            def tolist(self):
                raise ValueError("simulated tolist failure")

        self.fake.outputs.append(
            {
                "dense_vecs": NdArray([ThrowingRow()]),
                "lexical_weights": [{}],
            }
        )
        status, payload = self.request(
            "/encode",
            {"contract": contract.CONTRACT, "texts": ["текст"]},
        )
        self.assertEqual(status, 500)
        self.assertEqual(payload, {"error": "model_failure"})

    def test_throwing_item_is_model_failure(self):
        class ThrowingScalar:
            def item(self):
                raise ValueError("simulated item failure")

        self.fake.outputs.append(
            {
                "dense_vecs": NdArray([NdRow(dense_row())]),
                "lexical_weights": [{"3": ThrowingScalar()}],
            }
        )
        status, payload = self.request(
            "/encode",
            {"contract": contract.CONTRACT, "texts": ["текст"]},
        )
        self.assertEqual(status, 500)
        self.assertEqual(payload, {"error": "model_failure"})

    def test_malformed_pure_python_colbert_is_model_failure(self):
        # A non-numeric row forces the pure-Python coercion path to fail.
        self.fake.outputs.append(
            {"colbert_vecs": [[[1.0, 0.0]], [["not-a-number"]]]}
        )
        status, payload = self.request(
            "/rerank",
            {
                "contract": contract.CONTRACT,
                "query": "запрос",
                "candidates": ["кандидат"],
            },
        )
        self.assertEqual(status, 500)
        self.assertEqual(payload, {"error": "model_failure"})


class IndexableContainerTest(unittest.TestCase):
    def test_rejects_str_bytes_and_mapping_containers(self):
        for bad in ("garbage", b"garbage", {"0": 1}):
            with self.assertRaises(server.ModelInferenceError):
                server._as_indexable(bad, "dense_vecs")

    def test_row_to_list_wraps_throwing_tolist(self):
        class ThrowingRow:
            def tolist(self):
                raise ValueError("boom")

        with self.assertRaises(server.ModelInferenceError):
            server._row_to_list(ThrowingRow())


if __name__ == "__main__":
    unittest.main()
