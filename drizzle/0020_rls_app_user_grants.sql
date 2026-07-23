-- RLS deploy hardening: prepara a role NÃO-owner `app_user` para ser a conexão
-- da aplicação (fecha o vazamento cross-tenant onde o app conectava como o
-- superuser/owner `casper`, que ignora até FORCE ROW LEVEL SECURITY).
--
-- Esta migração roda como o owner (`casper`) — o único que pode conceder GRANTs
-- e alterar defaults. Ela NÃO dá LOGIN/senha ao app_user: a credencial vem do
-- ambiente no deploy (job `app-db-init` no compose faz o ALTER ROLE ... LOGIN
-- PASSWORD lendo APP_DB_PASSWORD). Assim nenhuma senha fica versionada.
--
-- app_user é NOLOGIN + sem BYPASSRLS + não-owner → as policies de 0008 filtram
-- de fato as linhas por app.user_id. Ver drizzle/0008_rls_multitenant.sql.

-- Garante a role (idempotente; 0008 já cria, mas migrações podem rodar isoladas).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint

-- Acesso ao schema onde vivem as tabelas da aplicação.
GRANT USAGE ON SCHEMA public TO app_user;
--> statement-breakpoint

-- Privilégios de dados em TODAS as tabelas existentes do schema public. RLS
-- continua sendo a fronteira de isolamento: GRANT dá o direito de tentar a
-- query; a policy decide quais linhas retornam. Tabelas sem user_id (user,
-- session, account, verification, rate_limit*) não têm RLS — o app precisa
-- delas para auth/rate-limit e o acesso é legítimo.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
--> statement-breakpoint

-- Sequences (colunas serial/identity): sem USAGE, INSERT quebra com
-- "permission denied for sequence".
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
--> statement-breakpoint

-- Defaults para objetos FUTUROS criados pelo owner (próximas migrações) — para
-- não precisar re-conceder a cada tabela nova. Aplica-se apenas ao que `casper`
-- criar daqui pra frente.
ALTER DEFAULT PRIVILEGES FOR ROLE casper IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE casper IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user;
--> statement-breakpoint

-- Função helper das policies: app_user precisa poder executá-la (é chamada
-- dentro do USING/WITH CHECK de cada policy).
GRANT EXECUTE ON FUNCTION app_row_visible(text) TO app_user;
--> statement-breakpoint

-- Mastra (agent memory/telemetry/vector) cria e gerencia as PRÓPRIAS tabelas em
-- runtime, num schema dedicado `mastra` (ver src/mastra/storage.ts). Como o app
-- conecta agora como app_user (não-superuser, sem CREATE na database), ele não
-- consegue criar o schema sozinho — o owner cria aqui e concede USAGE+CREATE
-- só nesse schema (Mastra ainda cria as tabelas dele on-demand, mas confinado
-- a `mastra`, nunca em `public` onde vivem as tabelas tenant).
-- Mastra emite `CREATE SCHEMA mastra` no boot (não checa se já existe), o que
-- exige o privilégio CREATE na DATABASE. Concedê-lo ao app_user é um
-- afrouxamento MÍNIMO e seguro: permite criar schemas/objetos, mas NÃO é
-- BYPASSRLS nem superuser — as policies FORCE ROW LEVEL SECURITY nas tabelas
-- tenant continuam valendo. Sem isto o app (não-owner) não sobe.
GRANT CREATE ON DATABASE casperagent TO app_user;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS mastra AUTHORIZATION app_user;
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA mastra TO app_user;
--> statement-breakpoint

-- pgvector: Memory usa embeddings (PgVector). A extensão é global e só o
-- superuser/owner pode criá-la; app_user apenas a usa. Criada de forma
-- condicional: a imagem postgres:17-alpine NÃO empacota pgvector, então
-- CREATE EXTENSION falharia e derrubaria a migração. Use uma imagem com
-- pgvector (ex.: pgvector/pgvector:pg17) para habilitar semantic recall; sem
-- ela, o resto do app funciona e só o Memory vector é degradado.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  ELSE
    RAISE NOTICE 'pgvector not available in this image — skipping (semantic recall disabled)';
  END IF;
END $$;
