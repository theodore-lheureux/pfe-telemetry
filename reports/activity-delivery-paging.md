# Delivery-led Explorer paging

Explorer orders overlapping deliveries by receipt time, newest received first, then measurements within each delivery by event time. The cursor keeps the measurement range, receipt ceiling, delivery coordinates and a position within an unfinished delivery. A late receipt can therefore appear before a more recent measurement in an older receipt. `FINAL` picks the winning sample before the raw partition and offset are matched. Page hydration checks the same coordinates, so a replacement that arrives between queries cannot be attributed to the old receipt.

The only added storage is the `activity_event_minmax` index on `metric_points`. The query also uses the selected delivery's sources, bounds and filtered series keys. The index alone does not make a global measurement-time scan viable: the middle of a merged part still exceeded the 4M-row cap for a 50 ms range. A receipt that exceeds the query budget is scanned in smaller event windows; if no progress fits, the reader returns a capacity error rather than skipping that receipt.

## Local measurement

The fixture contains 126M points over 30 minutes at 70k points/s, 80k active series, 350k total series, and 216k synthetic deliveries across 120 sources. Receipts span one second in this load test. A separate ClickHouse regression fixture covers 1,400 series from one source in a 35-minute delivery, a late resend and cross-receipt continuation.

The actual Explorer reader returned 100 points on each of the first two pages in every case, with 200 distinct point keys. Values below are the worst individual statement across both pages, including receipt selection, key search, and hydration, from ClickHouse HTTP summaries. The query limits were 4M rows, 6 s and 64 MiB with one thread.

| Last-hour filter            | Edge: rows / ms / MiB | Historical: rows / ms / MiB |
| --------------------------- | --------------------- | --------------------------- |
| None                        | 404,272 / 41 / 12.5   | 1,036,080 / 87 / 12.5       |
| One metric                  | 155,648 / 9 / 10.2    | 188,416 / 29 / 10.2         |
| Resource attribute equality | 566,000 / 43 / 12.8   | 566,000 / 42 / 12.8         |
| Resource attribute exists   | 566,000 / 42 / 11.5   | 1,036,080 / 94 / 9.3        |

The receipt-aligned fixture used 790,905 bytes for the index and marks, or **0.0063 B/point**. This is below the 0.2 B/point budget and replaces the experimental 6.54 B/point key table. These are local results; larger delivery histories, wider attributes, and overlapping parts can change pruning and latency.
