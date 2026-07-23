-- Reconciliação de ownership do schema `mastra` para a role NÃO-owner `app_user`.
--
-- Contexto: a 0020 pretendia que o schema mastra fosse OWNED por app_user
-- (`CREATE SCHEMA IF NOT EXISTS mastra AUTHORIZATION app_user`), para que o app
-- rodando como app_user pudesse criar/alterar as próprias tabelas mastra_* em
-- runtime (Mastra faz DDL idempotente no boot — ver src/mastra/storage.ts
-- ensureMastraStoreInit → PostgresStore.init). Esse é o padrão suportado pelo
-- Mastra: a role de runtime dona do schema gerencia o DDL confinado a ele.
--
-- Bug: em deploys onde o schema `mastra` e suas tabelas JÁ existiam (criados
-- antes, quando o app conectava como o owner `casper`), o `IF NOT EXISTS` da
-- 0020 encontrou o schema pronto e IGNOROU o `AUTHORIZATION app_user`. Resultado:
-- schema + tabelas continuaram OWNED por casper; o app (app_user) recebeu apenas
-- USAGE/CREATE + GRANTs de DML, que NÃO permitem ALTER/CREATE TABLE sobre objetos
-- de outro dono → "permission denied for schema mastra" e HTTP 500 no chat.
--
-- Esta migração roda como o owner (casper) e reatribui, de forma idempotente, o
-- ownership do schema mastra e de TODOS os objetos dentro dele para app_user.
-- Em deploy limpo (schema já nasce app_user pela 0020) é no-op.

DO $$
DECLARE
  r record;
BEGIN
  -- Só age se o schema existir (em instalações onde Mastra nunca subiu, o schema
  -- pode não existir ainda; a 0020 já o cria com AUTHORIZATION app_user).
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'mastra') THEN

    -- Owner do próprio schema.
    IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'mastra') <> 'app_user' THEN
      EXECUTE 'ALTER SCHEMA mastra OWNER TO app_user';
    END IF;

    -- Tabelas.
    FOR r IN
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'mastra' AND tableowner <> 'app_user'
    LOOP
      EXECUTE format('ALTER TABLE mastra.%I OWNER TO app_user', r.tablename);
    END LOOP;

    -- Sequences (se houver colunas serial/identity).
    FOR r IN
      SELECT sequencename FROM pg_sequences
      WHERE schemaname = 'mastra' AND sequenceowner <> 'app_user'
    LOOP
      EXECUTE format('ALTER SEQUENCE mastra.%I OWNER TO app_user', r.sequencename);
    END LOOP;

    -- Views (se houver).
    FOR r IN
      SELECT viewname FROM pg_views
      WHERE schemaname = 'mastra' AND viewowner <> 'app_user'
    LOOP
      EXECUTE format('ALTER VIEW mastra.%I OWNER TO app_user', r.viewname);
    END LOOP;

  END IF;
END $$;
