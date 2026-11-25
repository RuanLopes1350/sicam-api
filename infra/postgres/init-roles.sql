-- Provisionamento Least Privilege conforme Modelagem Física (Seções 1 e 9)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator WITH LOGIN PASSWORD 'migrator_dev_secret' CREATEDB;
  END IF;

  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime WITH LOGIN PASSWORD 'runtime_dev_secret' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

ALTER DATABASE sicam OWNER TO app_migrator;
GRANT CONNECT ON DATABASE sicam TO app_migrator, app_runtime;
GRANT ALL PRIVILEGES ON SCHEMA public TO app_migrator;
-- Extensões PostGIS e pgcrypto requerem privilégio de superusuário na primeira ativação
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
