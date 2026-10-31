\set ON_ERROR_STOP on
\getenv ingestion_password PFE_INGESTION_PASSWORD

SELECT 'CREATE ROLE pfe_ingestion' WHERE NOT EXISTS (
    SELECT FROM pg_roles WHERE rolname = 'pfe_ingestion'
) \gexec
ALTER ROLE pfe_ingestion WITH LOGIN PASSWORD :'ingestion_password'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT 4;
ALTER ROLE pfe_ingestion SET default_transaction_read_only = on;
ALTER ROLE pfe_ingestion SET statement_timeout = '1s';
ALTER ROLE pfe_ingestion SET lock_timeout = '500ms';
SELECT format('GRANT CONNECT ON DATABASE %I TO pfe_ingestion', current_database()) \gexec
REVOKE ALL ON SCHEMA app FROM pfe_ingestion;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM pfe_ingestion;
REVOKE ALL ON SCHEMA ingestion FROM pfe_ingestion;
REVOKE ALL ON ALL TABLES IN SCHEMA ingestion FROM pfe_ingestion;
GRANT USAGE ON SCHEMA ingestion TO pfe_ingestion;
GRANT SELECT ON ingestion.collector_credential TO pfe_ingestion;
