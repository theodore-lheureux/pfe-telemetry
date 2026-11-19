# Compact delivery provenance trial

The compact layout emitted one evidence frame per raw export and used 16% less disk for points plus deliveries in the local collector replay. Normalizer preparation CPU fell; this run did not establish a ClickHouse CPU improvement.

| Measurement                                                | Before (`b2e05f3`) |       Compact |
| ---------------------------------------------------------- | -----------------: | ------------: |
| Raw exports / points                                       |      480 / 555,840 | 480 / 555,840 |
| Normalized frames carrying delivery evidence               |              5,080 |           480 |
| Encoded delivery evidence, excluding framing and keys      |          456,038 B |     593,170 B |
| Active delivery rows before merges                         |                511 |           480 |
| Active delivery rows after merges                          |                480 |           480 |
| Merged point disk bytes per point                          |              10.85 |          9.05 |
| Merged delivery disk bytes per point                       |              0.060 |         0.064 |
| Merged points + deliveries disk bytes per point            |          **10.91** |      **9.12** |
| Normalizer preparation CPU-s per 1,000 points              |        **0.00560** |   **0.00480** |
| ClickHouse insert CPU-s                                    |               3.86 |          3.97 |
| ClickHouse merge CPU-s, all three tables, part log         |               2.50 |          1.83 |
| ClickHouse merge CPU-s, points + deliveries only, part log |               0.83 |          0.85 |

Both runs used the 1,158-point [collector fixture](../tooling/load/fixtures/collector.json) with 24 source IDs, 20 exports per source, adjusted timestamps, and synthetic trusted raw envelopes. Each request bound 142 resources. Release-build normalizer validation and packing ran offline over identical raw Protobuf bytes. CPU is the median of three runs (user plus system), including file I/O but excluding Kafka. The wire evidence counts are counted before ClickHouse can collapse identical deliveries inside each block. The fixture uses short common request evidence and simple bound resource contexts; total encoded evidence grew because the new bundle records the per-resource scopes explicitly instead of collapsing identical contexts into one key. It does not reproduce Oracle's provenance mix.

ClickHouse 26.8.34.13 consumed the packed frames in 16,000-row blocks through the real insert views with a `Null` input table in place of Kafka. Insert CPU is the container CPU delta; merge CPU uses `system.part_log` after re-enabling merges and optimizing all three tables. The apparent aggregate merge improvement came from `metric_series`, not from the changed tables. Final point counts and a checksum over identities and values matched. The receipt tag measured 0.31 compressed B/point versus 2.10 for the old digest in this fixture; the Oracle baseline digest was 15.9 B/point, so the local disk delta should not be extrapolated directly.
