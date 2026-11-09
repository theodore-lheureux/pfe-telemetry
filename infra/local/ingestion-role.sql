\set ON_ERROR_STOP on
\getenv ingestion_password RECOUNT_INGESTION_PASSWORD

SELECT 'CREATE ROLE recount_ingestion' WHERE NOT EXISTS (
    SELECT FROM pg_roles WHERE rolname = 'recount_ingestion'
) \gexec
ALTER ROLE recount_ingestion WITH LOGIN PASSWORD :'ingestion_password'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT 4;
ALTER ROLE recount_ingestion SET default_transaction_read_only = on;
ALTER ROLE recount_ingestion SET statement_timeout = '1s';
ALTER ROLE recount_ingestion SET lock_timeout = '500ms';
SELECT format('GRANT CONNECT ON DATABASE %I TO recount_ingestion', current_database()) \gexec
REVOKE ALL ON SCHEMA app FROM recount_ingestion;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM recount_ingestion;
REVOKE ALL ON SCHEMA ingestion FROM recount_ingestion;
REVOKE ALL ON ALL TABLES IN SCHEMA ingestion FROM recount_ingestion;
GRANT USAGE ON SCHEMA ingestion TO recount_ingestion;
GRANT SELECT ON ingestion.collector_credential,
    ingestion.collector_root_grant, ingestion.collector_resource_grant TO recount_ingestion;
