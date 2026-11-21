# Time-key table experiment for Explorer

This experiment is superseded by [delivery-led Explorer paging](activity-delivery-paging.md). Its extra storage exceeded the budget.

Explorer starts with a two-second key search. Its `metric_point_times` table groups keys into four-second buckets by project and keeps repeated series and streams adjacent within each bucket. A time-only skip index on `metric_points` cannot provide the same pruning: a granule in series order can span most of the time window. Selecting recently seen series alone still leaves about 80,000 candidates at this load.

The index stores only sample identity. Its `FINAL` removes replayed keys before the limit; the original point table still supplies the winning receipt and values. Explorer uses the same descending measurement time, series and stream order. Series filters run before the page limit. Page hydration supplies the metric, series and time together so the existing point index can narrow the read. Sparse searches widen and resume from the last searched cursor if the request budget ends; they do not sample or discard matching series.

## Local measurement

ClickHouse 26.8.34.13 held 126 million points at 70,000 points/s of event time across 30 minutes, 80,000 active series, 350,000 total series and 32 metrics. The synthetic data used stable streams and two resource attributes per series. This measures reads on a populated shared local server, not ingestion throughput at 70,000 points/s. The previous five-minute key query was rejected at **50.82 million estimated rows** against the 4-million-row limit.

The web reader fetched the first two pages of Last hour for each case, with one thread, a six-second timeout and a 64 MiB memory limit. Each page returned 100 measurements; the two pages contained 200 distinct keys. Figures are the maximum ClickHouse HTTP summary values for any statement in each stage across the two pages.

| Case                               | Key search rows | Key search ms | Key search MiB | Hydration rows | Hydration ms | Hydration MiB |
| ---------------------------------- | --------------: | ------------: | -------------: | -------------: | -----------: | ------------: |
| Unfiltered                         |         630,736 |           132 |           11.3 |      1,080,602 |          357 |          19.8 |
| One metric                         |         297,120 |             8 |            7.1 |        199,680 |           53 |          11.8 |
| Resource attribute equality        |         630,736 |            85 |            8.1 |      1,404,512 |          281 |          20.0 |
| Broad resource attribute existence |         630,736 |            56 |           12.2 |      1,080,602 |          144 |          19.8 |

The index used **823 MB (6.54 B/point)** including marks and indexes when sampled. A straight time-ordered layout tested on the same synthetic keys used 1.80 GB (14.32 B/point); grouping within four-second buckets improved compression at the cost of reading neighboring points in a bucket. Disk and query figures depend on stream churn, attribute width and merge state. The synthetic fixture did not measure ingest overhead, late-lane bursts or wide production attribute arrays.
