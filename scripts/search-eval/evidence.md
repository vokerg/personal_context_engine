# Synthetic search evaluation evidence — #145

Baseline: `fd33b5857b9e464abf23f7eb414f37362566874a`. PostgreSQL 16, UTF-8 character classification, exact stored 1536-dimensional OpenAI vectors. No private queries, note IDs, text or vectors are included. See [method and limitations](../../docs/22-search-evaluation.md).

## Development alternatives (48 queries)

| Alternative | P@5 | R@5 | MRR | nDCG@5 | No-answer FPR |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 0.1708 | 0.9762 | 0.8909 | 0.9116 | 1.0000 |
| lexical | 0.1333 | 0.7619 | 0.6788 | 0.6913 | 1.0000 |
| semantic | 0.1750 | 1.0000 | 0.9762 | 0.9824 | 1.0000 |
| stem | 0.1750 | 1.0000 | 0.8452 | 0.8850 | 1.0000 |
| weighted | 0.1750 | 1.0000 | 0.8929 | 0.9202 | 1.0000 |
| density | 0.1750 | 1.0000 | 0.8929 | 0.9202 | 1.0000 |
| full_title | 0.1750 | 1.0000 | 0.8929 | 0.9202 | 1.0000 |
| promote | 0.1750 | 1.0000 | 0.8929 | 0.9202 | 1.0000 |
| cutoff_0.2 | 0.1750 | 1.0000 | 0.8948 | 0.9218 | 1.0000 |
| cutoff_0.25 | 0.1750 | 1.0000 | 0.8968 | 0.9235 | 1.0000 |
| cutoff_0.3 | 0.1750 | 1.0000 | 0.9127 | 0.9354 | 1.0000 |
| cutoff_0.35 | 0.1667 | 0.9524 | 0.8889 | 0.9053 | 1.0000 |
| cutoff_0.4 | 0.1625 | 0.9286 | 0.8810 | 0.8934 | 1.0000 |
| rrf_10 | 0.1750 | 1.0000 | 0.8929 | 0.9202 | 1.0000 |
| rrf_30 | 0.1750 | 1.0000 | 0.8929 | 0.9202 | 1.0000 |
| lexical_weight_1.5 | 0.1750 | 1.0000 | 0.8929 | 0.9202 | 1.0000 |
| lexical_weight_2 | 0.1750 | 1.0000 | 0.8929 | 0.9202 | 1.0000 |
| lexical_weight_3 | 0.1750 | 1.0000 | 0.8929 | 0.9202 | 1.0000 |
| relative_0.5 | 0.1750 | 1.0000 | 0.8929 | 0.9202 | 1.0000 |
| relative_0.65 | 0.1750 | 1.0000 | 0.8929 | 0.9202 | 1.0000 |
| relative_0.8 | 0.1750 | 1.0000 | 0.8929 | 0.9202 | 1.0000 |
| and_0_false | 0.1750 | 1.0000 | 0.9762 | 0.9824 | 0.6667 |
| and_0_true | 0.1750 | 1.0000 | 0.9762 | 0.9824 | 0.6667 |
| and_0.5_false | 0.1750 | 1.0000 | 0.9762 | 0.9824 | 0.6667 |
| and_0.5_true | 0.1750 | 1.0000 | 0.9762 | 0.9824 | 0.6667 |
| and_0.65_false | 0.1750 | 1.0000 | 0.9762 | 0.9824 | 0.6667 |
| and_0.65_true | 0.1750 | 1.0000 | 0.9762 | 0.9824 | 0.6667 |
| and_0.8_false | 0.1750 | 1.0000 | 0.9762 | 0.9824 | 0.6667 |
| and_0.8_true | 0.1750 | 1.0000 | 0.9762 | 0.9824 | 0.6667 |
| and_lexical | 0.0583 | 0.3333 | 0.3333 | 0.3333 | 0.0000 |

## Validation, 48 queries

| Model | P@1 | P@5 | R@5 | R@10 | R@200 | MRR | nDCG@5 | No-answer FPR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 0.6042 | 0.1625 | 0.9286 | 0.9524 | 1.0000 | 0.8050 | 0.8312 | 1.0000 |
| lexical | 0.4792 | 0.1208 | 0.6905 | 0.7143 | 0.7143 | 0.5982 | 0.6187 | 1.0000 |
| semantic | 0.7708 | 0.1750 | 1.0000 | 1.0000 | 1.0000 | 0.9405 | 0.9561 | 1.0000 |
| current | 0.7708 | 0.1750 | 1.0000 | 1.0000 | 1.0000 | 0.9405 | 0.9561 | 0.1667 |
| fallback | 0.6458 | 0.1500 | 0.8571 | 0.8571 | 0.8571 | 0.7786 | 0.7979 | 0.1667 |

| Category | Queries | R@5 before | R@5 after | nDCG@5 before | nDCG@5 after |
| --- | ---: | ---: | ---: | ---: | ---: |
| exact | 6 | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| inflection | 6 | 1.0000 | 1.0000 | 0.8770 | 0.9385 |
| long | 6 | 0.5000 | 1.0000 | 0.4385 | 0.9385 |
| multilingual | 6 | 1.0000 | 1.0000 | 0.8770 | 0.9385 |
| no_answer | 6 | — | — | — | — |
| question | 6 | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| semantic | 6 | 1.0000 | 1.0000 | 0.6872 | 0.9385 |
| typo | 6 | 1.0000 | 1.0000 | 0.9385 | 0.9385 |

Local SQL transaction latency in milliseconds, five initial observations omitted:

| Model | p50 | p95 |
| --- | ---: | ---: |
| baseline | 2.28 | 2.77 |
| current | 3.93 | 4.85 |

## Fresh confirmation, 32 queries

| Model | P@1 | P@5 | R@5 | R@10 | R@200 | MRR | nDCG@5 | No-answer FPR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 0.6875 | 0.1688 | 0.9643 | 0.9643 | 1.0000 | 0.8613 | 0.8850 | 1.0000 |
| lexical | 0.5000 | 0.1250 | 0.7143 | 0.7143 | 0.7143 | 0.6280 | 0.6497 | 0.7500 |
| semantic | 0.7500 | 0.1750 | 1.0000 | 1.0000 | 1.0000 | 0.9286 | 0.9473 | 1.0000 |
| current | 0.7813 | 0.1750 | 1.0000 | 1.0000 | 1.0000 | 0.9464 | 0.9605 | 0.2500 |
| fallback | 0.5938 | 0.1500 | 0.8571 | 0.8571 | 0.8571 | 0.7500 | 0.7769 | 0.2500 |

| Category | Queries | R@5 before | R@5 after | nDCG@5 before | nDCG@5 after |
| --- | ---: | ---: | ---: | ---: | ---: |
| exact | 4 | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| inflection | 4 | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| long | 4 | 0.7500 | 1.0000 | 0.4717 | 0.9077 |
| multilingual | 4 | 1.0000 | 1.0000 | 0.9077 | 1.0000 |
| no_answer | 4 | — | — | — | — |
| question | 4 | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| semantic | 4 | 1.0000 | 1.0000 | 0.9077 | 0.9077 |
| typo | 4 | 1.0000 | 1.0000 | 0.9077 | 0.9077 |

Local SQL transaction latency in milliseconds, five initial observations omitted:

| Model | p50 | p95 |
| --- | ---: | ---: |
| baseline | 4.14 | 4.83 |
| current | 4.60 | 5.59 |

## Regressions and interpretation

The original validation set was inspected to reject pruning; it is consequently validation evidence, not an untouched final test. The separate confirmation families were written and frozen before running the final policy.

On validation, `garden-4` (misspelling) and `telescope-2` (paraphrase) move from rank 1 to rank 2, each nDCG@5 1.0000 → 0.6309. The former loses an accidental partial-word lexical vote; the latter loses a coincidental lexical advantage over a semantically similar repair note. Both remain retrievable. Category averages hide these regressions: report them separately. No confirmation query loses nDCG@5 relative to baseline.

No-answer improvement is dominated by absent identifiers. Related but unsupported non-identifier requests still return plausible documents. The synthetic corpus has one judged positive per answerable query and explicitly contrastive hard negatives; it does not establish real-world precision, broad ambiguity handling or statistical significance.

Fixture hashes (SHA-256 of parsed benchmark):

- Development/validation: `060fe07d20fedf47b77cae69c71751ac1491bea6e946f9845c97ed249674e169`
- Confirmation: `e86b1a98ac506386670b18b3ff5c6fec714ba206b9b634ba9828de483e495a3b`

## Keyword precision follow-up

Version v3 applies a title-backed admission gate only to single-token lookups. These 20 additional queries were frozen before the v3 run. This comparison is against v2 (`fd590ff`), not the original `fd33b58` baseline.

| Set | R@5 before → after | nDCG@5 before → after | All-returned precision before → after | Full-window recall before → after |
| --- | --- | --- | --- | --- |
| Original validation (48) | 1.0000 → 1.0000 | 0.9561 → 0.9561 | 0.2232 → 0.2418 | 1.0000 → 1.0000 |
| Original confirmation (32) | 1.0000 → 1.0000 | 0.9605 → 0.9605 | 0.1704 → 0.1991 | 1.0000 → 1.0000 |
| Keyword confirmation (20) | 0.9474 → 0.9474 | 0.9016 → 0.9016 | 0.1751 → 0.7198 | 0.9474 → 0.9474 |

Keyword confirmation mean precision among the first five returned results improves 0.3105 → 0.7351. Fixed-denominator P@5 remains 0.2900; reducing irrelevant result counts is invisible to fixed-K precision when all relevant items are already present. Full-list returned precision is therefore reported explicitly. Empty result lists have undefined returned precision and are excluded from that macro average; no-answer FPR remains separately reported.

One conceptual query has no result before or after; the absent-term query still returns unrelated results. None of the 20 confirmation queries loses a previously retrieved judged positive. The original private recheck also preserves judged full-window recall; private evidence remains outside this repository.

Local keyword SQL p50/p95 rises from 3.96/4.79 ms in v2 to 5.40/7.45 ms in v3. This is a small cached-vector local measurement, not a deployment SLO.
