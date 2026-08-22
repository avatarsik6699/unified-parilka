# Local BGE-M3 service (operator-owned)

Loopback encode/rerank service that replaces the external dense embedding
provider for bot-agi retrieval. One encode pass emits the dense vector (1024)
and the learned sparse token weights stored in
`message_embedding_sparse_terms`; `/rerank` scores a bounded candidate list
with ColBERT late interaction and never returns token vectors.

This service is the recommended production path for
`TELEGRAM_EMBEDDINGS_BACKEND=local_bge_m3`. The external OpenAI-compatible
provider remains only as a backward-compatible, disabled-by-default option.

## Wire contract

| Endpoint | Method | Input bounds | Output |
| --- | --- | --- | --- |
| `/health` | GET | — | status `ok`\|`loading`\|`error`, model id, contract id |
| `/encode` | POST | ≤ 64 texts, ≤ 8000 chars each | per text: dense 1024 + sparse `[token_id, weight]` terms |
| `/rerank` | POST | query ≤ 2000 chars, ≤ 32 candidates | finite score per candidate, input order |

Contract constants live in `contract.py` and are mirrored by the TypeScript
client `src/vector/bge-client.ts` (`LOCAL_BGE_SERVICE_CONTRACT = "bge-m3-v1"`).
Rotate both together. The model id is fixed to `BAAI/bge-m3`; no request can
change the model, load paths, or fetch URLs. The service takes no credential
and the TypeScript client sends none.

## What this repository does NOT do

- Model artifacts are **not vendored**. First startup downloads `BAAI/bge-m3`
  (MIT license) from Hugging Face into the operator cache.
- No dependency is installed by any repository command. `requirements.txt`
  is a set of **selected top-level compatibility pins** for the model stack;
  not every pinned package is imported by this service directly. It is **not
  a full reproducible lock** — transitive dependencies are left to the
  resolver. Treat it as metadata until the operator
  provisions the venv below, verify the pins against current PyPI releases
  before installing, and keep the resolved lock (e.g. `pip freeze`) in
  operator records if reproducibility matters. The service contract depends
  only on `BGEM3FlagModel.encode` returning `dense_vecs`,
  `lexical_weights`, and `colbert_vecs`.
- Production cutover (venv install, model download, backfill indexing, unit
  enable, service restarts) requires separate operator approval; nothing here
  starts or enables anything.

## Provisioning (operator, one-time)

```bash
python3 -m venv ~/.venvs/bot-agi-bge-m3
~/.venvs/bot-agi-bge-m3/bin/pip install -r services/bge-m3/requirements.txt
# Optional: pre-download the model into the HF cache.
~/.venvs/bot-agi-bge-m3/bin/python - <<'PY'
from FlagEmbedding import BGEM3FlagModel
BGEM3FlagModel("BAAI/bge-m3", use_fp16=True)
PY
```

Python 3.11–3.13 recommended (wheel availability for torch/FlagEmbedding);
check current wheel support before choosing an interpreter.

## Running

Foreground (default loopback bind `127.0.0.1:8767`):

```bash
bin/bot-agi-bge-m3 --host 127.0.0.1 --port 8767
```

systemd (shipped **disabled**; enable only after provisioning and cutover
approval):

```bash
systemctl --user daemon-reload
systemctl --user enable --now bot-agi-bge-m3.service   # explicit operator step
systemctl --user status bot-agi-bge-m3.service
```

The server itself refuses non-loopback `--host` (it exits at argument
parsing); the wrapper only forwards arguments, and the systemd unit
hard-codes the loopback bind. GPU use follows the visible CUDA device;
CPU-only works but is slow for backfill.

## Application configuration

```dotenv
TELEGRAM_EMBEDDINGS_ENABLED=true
TELEGRAM_EMBEDDINGS_BACKEND=local_bge_m3
TELEGRAM_EMBEDDINGS_LOCAL_ENDPOINT=http://127.0.0.1:8767
# Optional bounded ColBERT rerank over the first-stage top-K (0 disables).
TELEGRAM_EMBEDDINGS_RERANK_MAX_CANDIDATES=8
```

Validation pins model `bge-m3` and dimensions `1024`; the endpoint must be a
loopback HTTP(S) root origin without credentials, query, fragment, or base
path. Indexing and query both degrade to BM25 when the service is down;
`keyword_search` and `read_chat_slice` never depend on it.

## Tests

```bash
npm run test:service-contract   # stdlib-only wire contract tests, no torch
```
