-- Custom SQL migration file, put your code below! --
ALTER TABLE ingestion.collector_node SET (
    fillfactor = 75,
    autovacuum_vacuum_threshold = 50,
    autovacuum_vacuum_scale_factor = 0.05
);
