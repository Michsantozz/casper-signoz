-- Torna o semantic recall do agente funcional: (1) backfill idempotente da
-- extensão pgvector para volumes migrados na imagem ANTIGA e (2) remoção da tabela
-- de embeddings 4096-dim inutilizável, deixando o runtime recriar a versão 1024.
--
-- ── Parte 1: extensão pgvector ──────────────────────────────────────────────
-- A 0020 já emite `CREATE EXTENSION IF NOT EXISTS vector`, mas CONDICIONALMENTE —
-- só se `pg_available_extensions` listar `vector`. A imagem postgres:17-alpine
-- não empacota pgvector, então em DBs inicializados com ela a 0020 caiu no ramo
-- ELSE e a extensão NUNCA foi criada; o journal marcou a 0020 como aplicada,
-- então mesmo após trocar para `pgvector/pgvector:pg17` a 0020 não re-roda e o
-- type `vector` continua ausente → PgVector falha com `type "vector" does not
-- exist`.
--
-- ── Parte 2: descartar a tabela de embeddings 4096-dim ──────────────────────
-- O embedder era Qwen3-Embedding-8B em 4096 dimensões (tabela
-- `memory_messages_4096`, coluna `embedding vector(4096)`). O pgvector NÃO indexa
-- acima de 2000 dimensões — o limite vale para TODO tipo de índice (ivfflat E
-- hnsw) sobre o type `vector`. Como o Memory do Mastra cria o índice sem config,
-- o PgVector tentava indexar em 4096 e falhava com `column cannot have more than
-- 2000 dimensions for ... index`. O save da memória abortava, o step não concluía,
-- o Mastra RE-EXECUTAVA o passo e a resposta inteira era regenerada em loop — o
-- chat entrava em loop de geração infinito.
--
-- Fix (código): o embedder agora trunca para 1024 dimensões via MRL (Matryoshka)
-- — ver src/mastra/model.ts. Isso muda o nome do índice/tabela para
-- `memory_messages_1024`, que é indexável. A tabela 4096 antiga fica órfã e
-- sempre teve 0 linhas úteis (todo upsert falhava), então a removemos aqui. A
-- tabela 1024 e seu índice HNSW são criados em runtime por ensureMastraVectorIndex
-- (src/mastra/storage.ts) antes do primeiro uso do Memory.
--
-- Tudo idempotente (IF NOT EXISTS / IF EXISTS) e roda como owner (casper) via
-- drizzle-kit migrate.

-- Parte 1 — extensão global (fica em `public`; type resolvível a partir de `mastra`).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    CREATE EXTENSION IF NOT EXISTS vector;
  ELSE
    RAISE NOTICE 'pgvector not available in this image — skipping (semantic recall disabled)';
  END IF;
END $$;
--> statement-breakpoint

-- Parte 2 — remove a tabela de embeddings 4096-dim (não indexável, sempre vazia).
DROP TABLE IF EXISTS mastra.memory_messages_4096;
