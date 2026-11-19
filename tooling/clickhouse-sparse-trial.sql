-- Run only on a disposable server. Wide parts expose column serialization.
CREATE DATABASE series_sparse_trial;
CREATE TABLE series_sparse_trial.probe
(
    id UInt64,
    plain Int64,
    optional Nullable(Int64),
    present UInt8
)
ENGINE = MergeTree
ORDER BY id
SETTINGS ratio_of_defaults_for_sparse_serialization = 0.95, min_bytes_for_wide_part = 0;

INSERT INTO series_sparse_trial.probe
SELECT number,
       if(number % 2000 = 0, 42, 0),
       if(number % 1000 = 0, if(number % 2000 = 0, 42, 0), NULL),
       number % 1000 = 0
FROM numbers(600000);

SELECT column, serialization_kind, column_data_compressed_bytes
FROM system.parts_columns
WHERE database = 'series_sparse_trial' AND table = 'probe' AND active
ORDER BY column;

SELECT throwIf(countIf(NOT isNotDistinctFrom(optional, if(present, plain, NULL))) != 0,
               'Sparse presence representation changed the values')
FROM series_sparse_trial.probe;

DROP DATABASE series_sparse_trial SYNC;
