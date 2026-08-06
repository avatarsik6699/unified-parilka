"""Stdlib-only contract tests: no torch, no model files, no network."""

from __future__ import annotations

import unittest

import contract


class ParseEncodeRequestTest(unittest.TestCase):
    def test_accepts_bounded_batch(self):
        texts = contract.parse_encode_request(
            {"contract": contract.CONTRACT, "texts": ["привет", "hello"]}
        )
        self.assertEqual(texts, ["привет", "hello"])

    def test_rejects_wrong_contract(self):
        with self.assertRaises(contract.ContractError):
            contract.parse_encode_request({"contract": "other", "texts": ["x"]})

    def test_rejects_empty_batch(self):
        with self.assertRaises(contract.ContractError):
            contract.parse_encode_request(
                {"contract": contract.CONTRACT, "texts": []}
            )

    def test_rejects_oversized_batch(self):
        texts = ["x"] * (contract.MAX_BATCH_TEXTS + 1)
        with self.assertRaises(contract.ContractError):
            contract.parse_encode_request(
                {"contract": contract.CONTRACT, "texts": texts}
            )

    def test_rejects_oversized_text(self):
        texts = ["x" * (contract.MAX_CHARS_PER_TEXT + 1)]
        with self.assertRaises(contract.ContractError):
            contract.parse_encode_request(
                {"contract": contract.CONTRACT, "texts": texts}
            )

    def test_rejects_non_string_text(self):
        with self.assertRaises(contract.ContractError):
            contract.parse_encode_request(
                {"contract": contract.CONTRACT, "texts": [1]}
            )


class ParseRerankRequestTest(unittest.TestCase):
    def test_accepts_bounded_candidates(self):
        query, candidates = contract.parse_rerank_request(
            {
                "contract": contract.CONTRACT,
                "query": "кто говорил про релиз",
                "candidates": ["релиз в пятницу"],
            }
        )
        self.assertEqual(query, "кто говорил про релиз")
        self.assertEqual(candidates, ["релиз в пятницу"])

    def test_rejects_too_many_candidates(self):
        candidates = ["t"] * (contract.MAX_RERANK_CANDIDATES + 1)
        with self.assertRaises(contract.ContractError):
            contract.parse_rerank_request(
                {
                    "contract": contract.CONTRACT,
                    "query": "q",
                    "candidates": candidates,
                }
            )

    def test_rejects_long_query(self):
        with self.assertRaises(contract.ContractError):
            contract.parse_rerank_request(
                {
                    "contract": contract.CONTRACT,
                    "query": "q" * (contract.MAX_QUERY_CHARS + 1),
                    "candidates": ["t"],
                }
            )


class SparseTermsTest(unittest.TestCase):
    def test_dedupe_and_order(self):
        terms = contract.bounded_sparse_terms(
            [(5, 0.5), (5, 0.9), (2, 0.4), (9, 0.9)]
        )
        self.assertEqual(terms, [(2, 0.4), (5, 0.9), (9, 0.9)])

    def test_truncates_to_top_weights_deterministically(self):
        pairs = [(i, 1.0) for i in range(contract.MAX_SPARSE_TERMS + 10)]
        terms = contract.bounded_sparse_terms(pairs)
        self.assertEqual(len(terms), contract.MAX_SPARSE_TERMS)
        self.assertEqual(terms[0][0], 0)
        self.assertEqual(terms[-1][0], contract.MAX_SPARSE_TERMS - 1)

    def test_rejects_bad_token_id(self):
        with self.assertRaises(contract.ContractError):
            contract.bounded_sparse_terms([(-1, 0.1)])
        with self.assertRaises(contract.ContractError):
            contract.bounded_sparse_terms(
                [(contract.MAX_SPARSE_TOKEN_ID + 1, 0.1)]
            )

    def test_rejects_bad_weight(self):
        for bad in (0, -0.1, float("nan"), contract.MAX_SPARSE_WEIGHT + 1):
            with self.assertRaises(contract.ContractError):
                contract.bounded_sparse_terms([(1, bad)])


class DenseAndScoresTest(unittest.TestCase):
    def test_dense_dimensions_enforced(self):
        good = [0.0] * contract.DENSE_DIMENSIONS
        self.assertEqual(
            len(contract.bounded_dense_vector(good)),
            contract.DENSE_DIMENSIONS,
        )
        with self.assertRaises(contract.ContractError):
            contract.bounded_dense_vector([0.0] * 10)
        with self.assertRaises(contract.ContractError):
            contract.bounded_dense_vector(
                [float("nan")] * contract.DENSE_DIMENSIONS
            )

    def test_scores_length_and_finiteness(self):
        self.assertEqual(contract.bounded_scores([0.1, 0.2], 2), [0.1, 0.2])
        with self.assertRaises(contract.ContractError):
            contract.bounded_scores([0.1], 2)
        with self.assertRaises(contract.ContractError):
            contract.bounded_scores([float("inf"), 0.1], 2)


class BodyLimitTest(unittest.TestCase):
    def test_oversized_body_rejected(self):
        with self.assertRaises(contract.ContractError):
            contract.parse_json_body(
                b"x" * (contract.MAX_REQUEST_BYTES + 1)
            )

    def test_invalid_json_rejected(self):
        with self.assertRaises(contract.ContractError):
            contract.parse_json_body(b"{nope")


if __name__ == "__main__":
    unittest.main()
