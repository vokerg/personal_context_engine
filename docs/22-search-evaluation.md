# 22 — Search relevance evaluation (#145)

## Result and scope

The shared note/research backend uses multilingual lexical evidence with selective
RRF votes. The synthetic validation nDCG@5 improved from 0.8312 to 0.9561;
a fresh confirmation set improved from 0.8850 to 0.9605. These are small,
constructed benchmarks, not a statistical claim about general retrieval quality.
The complete [synthetic evidence](../scripts/search-eval/evidence.md) includes
individual regressions, category results, lexical/semantic comparisons and SQL
latency. Private investigation artifacts stay outside this repository.

Web, MCP and native iOS already call the same backend. There is no client-side
ranker, deployment, reindexing, capture change or ChatGPT default-path cutover.
Existing search/provider gates and rollback remain in [the search runbook](17-search.md).

## Evaluation method

Before executing rankings, the investigator read source notes and wrote graded
judgments independently of the current search output. Positive, irrelevant and
hard-negative documents were selected from content, not baseline rank. Judgments
are investigator-authored, with no independent human labeling/adjudication; some
ambiguous judgments are subjective. This limits conclusions.

The frozen development/validation corpus has 24 invented documents in 12 topic
families and 96 queries (48 development, 48 initial held-out). Every family has a
positive and a related hard negative. Eight scenarios per family cover exact
identifiers/names, English/Russian inflection, semantic paraphrase, mixed
languages, typos, natural-language questions, long requests and no-answer cases.
Question/long scenarios include dates, errands and projects. Family-level splits
prevent a paraphrase of a development topic from appearing as a held-out query;
all documents remain searchable as distractors. A separately authorized local
private snapshot supplied supplemental graded, multi-result, ambiguous, task,
date and project scenarios. Its text, labels, IDs, vectors and scores are withheld
from the public repository.

The initial held-out set exposed a deep-recall loss from relative pruning. After
rejecting that approach and retaining partial candidates, those results became
validation evidence. Four fresh topic families, eight new documents mixed with
the original 24 distractors and 32 queries were frozen before executing the final
policy. This confirmation is separate from tuning, but the same investigator and
query-writing template introduce correlation. No p-value or population-level
significance is claimed. Multiple queries about one topic are not independent
samples.

Metrics use unique note IDs: binary relevance is grade >0; P@K divides by fixed K
including missing result positions. R@K divides by all judged relevant notes;
MRR uses the full bounded result list. nDCG@K uses `(2^grade-1)/log2(rank+1)`.
No-answer queries contribute to precision and a separate any-result false-positive
rate; their undefined recall/MRR/nDCG are excluded from those macro averages.
Scores are reported at K=1/5/10 and full bounded recall at 200. Most synthetic
queries have one positive, so P@5 is inherently capped at 0.2 for those queries;
P@1, MRR, recall and no-answer FPR are more informative than P@5 alone.

Baseline and final ranking use the same frozen text and query/document vectors,
with exact PostgreSQL cosine scoring. Corpus snapshot hashes and vector caches
are retained privately. Synthetic metrics are reproducible with the cached
vectors; exact floating-point ties may vary across PostgreSQL/provider versions.
The baseline SQL is the note algorithm at `fd33b58`, independently checked against
the original production CTE during exploration. Saved reports had separate AND
lexical logic; the headline benchmark is note retrieval. Report behavior is
covered by PostgreSQL integration tests, not a large report relevance dataset.

An initial C-locale scratch run was discarded: Cyrillic case folding and stemming
require UTF-8 character classification. Published results use UTF-8. The runner
checks this before seeding. Production deployments should retain UTF-8 locale.

## Experiments and selection

- `simple` lexical, semantic-only and original equal RRF established branch
  baselines. Semantic-only often beat original hybrid: common words and partial
  topical overlap gained a full second RRF vote even with weak cosine.
- English/Russian stemming improved lexical recall but alone could worsen fusion.
  Title weighting, normalized frequency rank and cover-density rank were compared.
- RRF k=10/30/60 and lexical weights 1.5/2/3 did not justify changing equal k=60.
  Multiplying semantic votes by cosine also provided no consistent advantage.
- Absolute cutoffs 0.20/0.25/0.30/0.35/0.40 and relative-best factors
  0.50/0.65/0.80 improved returned precision at the cost of some weaker relevant
  results. Even factor 0.50 lost one weak ambiguous result in validation at deep
  recall. Reject hard pruning; retain the existing strict cosine >0.15 floor.
- Complete-query lexical evidence prevents incidental overlap receiving a hybrid
  vote. Keep partial OR candidates at zero fusion score behind evidence-bearing
  matches; in lexical-only fallback every candidate receives a lexical vote.
  This preserves partial-match availability during absent vectors/provider failure.
- Exact alphanumeric tokens such as `AX-912` constrain both branches. Neighboring
  codes and semantic alternatives cannot satisfy an explicit identifier. Literal
  boundaries prevent `AX-9120` satisfying `AX-912`. Numeric dates and ordinary
  hyphenated words do not activate this rule.

The selected SQL uses `simple` exact lexemes alongside built-in English/Russian
Snowball dictionaries. Complete evidence means all terms in at least one
configuration, or the literal full query substring. Rank full matches first,
then exact/substring title matches, then weighted normalized frequency (title A,
summary B, body D), with existing deterministic tie breaks. Partial candidates
still indicate `lexical: true` but diagnostics report `lexicalVote: false` in
hybrid mode. Two partial matches never fabricate a second independent vote.

These are conventional PostgreSQL primitives: see [ranking controls](https://www.postgresql.org/docs/16/textsearch-controls.html)
and [dictionaries](https://www.postgresql.org/docs/16/textsearch-dictionaries.html).
The [original RRF paper](https://cormack.uwaterloo.ca/cormack/cormacksigir09-rrf.pdf)
explains rank fusion; neither its results nor a cosine value establish relevance
for this personal corpus.

No paid reranker, generative query expansion, new service, new model or stemming
migration is justified by this small dataset. Fuzzy/trigram retrieval remains
unimplemented: embeddings recover many ordinary typos, but identifier typos
intentionally do not silently substitute a different code.

## Reproduce without provider calls

Build `@pce/core` and `@pce/db`, apply migrations to a disposable local PostgreSQL
16/pgvector database with UTF-8 locale, then provide a local cache:

```sh
PCE_DB_TEST_URL='postgresql://synthetic@localhost/pce_eval' \
PCE_SEARCH_EVAL_DISPOSABLE=I_CONFIRM_SYNTHETIC_DATABASE \
node scripts/search-eval/run.mjs /protected/vectors.json /protected/results.json
```

Append `--confirmation` for the fresh confirmation families. The script never
loads `.env`, embeds text or uses `DATABASE_URL`. It validates all cache entries
before seeding, writes only random-owner synthetic rows, and cleans up that
owner's rows and captures on completion/failure. It requires an explicitly
confirmed local test/eval database. Use a disposable database even though cleanup
is scoped. Tests run with fake vectors/providers and no external CI requests.

Cache shape is `{ "vectors": { "<sha256-of-input>": [1536 numbers] } }`.
Query input is the exact fixture query; document input is `title + "\n" + text`.
Generate/cache vectors separately only with explicit provider egress authorization
and existing cost/rate reservations. Do not commit caches, even synthetic ones;
the same cache may contain private inputs. Keep outputs protected when evaluating
private data. Fixture files contain only invented public content.

The investigation reused all existing private document vectors and made four
bounded standard embedding requests for 252 evaluation inputs (3,406 actual
input tokens; 18,210 conservatively reserved tokens), including synthetic
confirmation documents. Gates were checked and durable owner daily budget was
reserved before each request. No production originals/index rows changed.
Offline evaluation estimated cost was $0.00006812 at the documented $0.02/million input tokens;
actual account charges are outside this estimate. Array input and model pricing
are described in the [OpenAI embedding API](https://developers.openai.com/api/reference/resources/embeddings/methods/create)
and [model documentation](https://developers.openai.com/api/docs/models/text-embedding-3-small).
Requests took approximately 0.63–2.28 seconds in batches; this is not per-query
interactive latency. The final runtime still makes at most one existing query
embedding call, with unchanged cache, deadlines, rate and token reservations.

SQL measurements are local tiny-corpus transaction p50/p95, including the same
statement-timeout setup for baseline/current. They exclude provider/network and
client latency, and show a small absolute SQL overhead, not a production SLO.
No large-corpus/index/load claim is made.

## Known limits and regressions

Two validation queries fall from rank 1 to rank 2 (typo and semantic categories);
the category aggregate hides these cases. The local multi-result snapshot also
has an exact-query ordering regression among closely related notes, with no
judged full-window recall loss. Confirmation has no per-query nDCG@5 regression.

Absent-identifier queries become empty; broad related-but-unsupported questions
still frequently return plausible notes. This change is not an answerability
classifier. Ordinary short conceptual queries can still include unrelated
semantic candidates; the low floor preserves weak paraphrases. Mixed queries
requiring both English and Russian stemming in the same phrase may need semantic
assistance, since each complete-query dictionary branch is evaluated separately.
Negation, contradictions and historical supersession remain difficult for the
embedding model. A larger independently labeled real corpus is needed before
more aggressive filtering, learned ranking or a default retrieval cutover.


## Keyword precision follow-up

Owner feedback exposed a gap in v2: a temporarily rate-limited local check tested
lexical fallback, concealing the unrelated tail returned by normal hybrid search.
Better top ranks alone did not satisfy literal-lookup precision. That check is not
evidence of clean hybrid results.

Version `multilingual-keyword-v3` adds a narrow single-token policy. When at least
one matching title has a current compatible vector above the ordinary floor,
semantic-only candidates must be at least as close as the weakest title match.
Complete lexical matches remain available independently of this gate. Multiple
title matches lower the anchor conservatively; absent/unindexed anchors,
questions and phrases retain broad semantic retrieval. More strongly related
semantic-only notes can still pass, including notes without shared query words.
The same helper applies to notes and saved reports. Diagnostics expose the anchor,
`passedKeywordGate` and `below_keyword_anchor`; cursor/cache bindings use v3.

Broader policies based on arbitrary body matches or two/three-token queries lost
judged cross-language/related results and were rejected. The chosen single-token
title policy preserved judged full-window recall on the original private and
synthetic sets. The keyword-focused confirmation fixture was frozen before the
v3 run: 20 additional queries over 32 synthetic documents, including morphology,
multiple plausible interpretations, conceptual queries without title anchors and
an absent term. All-returned macro precision improved 0.1751 → 0.7198, while
R@5 remained 0.9474 and nDCG@5 remained 0.9016. One conceptual query was already
missed and remains missed; the unknown-term case still returns false positives.
Original validation/confirmation nDCG@5 and full-window recall are unchanged;
returned precision improves. See the [evidence addendum](../scripts/search-eval/evidence.md#keyword-precision-follow-up).

Run the same cache-only benchmark with `--keyword` for this fixture. The additional
20 embeddings used 55 actual input tokens, included in the offline totals above.
Ordinary authenticated local verification requests also use the existing query
budget; their costs are separate from those offline evaluation totals.

This policy favors precision for title-backed keyword lookups. A weaker valid
paraphrase below the title anchor can still be excluded in an unseen corpus,
particularly for single-word conceptual/ambiguous searches. Existing no-anchor
and question/phrase semantic retrieval remains broad. These small judged sets do
not prove that this risk is eliminated; no general answerability claim is made.
