-- RLS multi-tenant: FORCE ROW LEVEL SECURITY + policies nas tabelas com user_id.
--
-- Isolamento por usuário no BANCO (defense-in-depth), complementando o scoping
-- em código. As leituras/escritas passam por withUserScope(), que faz
-- `SET LOCAL app.user_id`; as policies filtram por essa flag. Operações de
-- sistema (webhooks, crons) usam withSystemScope() → app.bypass_rls = 'on'.
--
-- IMPORTANTE (deploy): o app deve conectar com uma role NÃO-owner. O owner da
-- tabela ignora RLS a menos que FORCE esteja ligado — usamos FORCE, mas mesmo
-- assim a role dedicada `app_user` é a fronteira correta. Conceda o mínimo:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON <tabelas> TO app_user;
-- e aponte DATABASE_URL para app_user. Ver docs/rls.md.

-- Role da aplicação (idempotente). Sem LOGIN aqui — a senha/So é setada no deploy.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint

-- Helper: predicado de isolamento reutilizado por todas as policies.
-- Verdadeiro quando (a) a linha é do usuário do escopo, ou (b) bypass de sistema.
-- current_setting(_, true) = missing_ok → NULL em vez de erro se a flag não foi setada.
CREATE OR REPLACE FUNCTION app_row_visible(row_user_id text)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    coalesce(current_setting('app.bypass_rls', true), 'off') = 'on'
    OR row_user_id = current_setting('app.user_id', true)
$$;
--> statement-breakpoint

-- Aplica RLS às tabelas tenant deste ciclo. FORCE garante que nem o owner
-- escapa. Uma policy FOR ALL cobre SELECT/INSERT/UPDATE/DELETE; WITH CHECK
-- impede inserir/atualizar linha de outro usuário.
--
-- ROLLOUT INCREMENTAL: as tabelas pré-existentes (signature_requests,
-- notifications, user_wallets, wallet_link_nonces) NÃO entram aqui — seus
-- callers ainda não passam por withUserScope/withSystemScope; ligá-las agora
-- quebraria endpoints. Migre os callers dessas tabelas para scopedDb() e adicione
-- as policies numa migration futura. Ver docs/rls.md.
ALTER TABLE "user_calendars" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_calendars" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_calendars_isolation" ON "user_calendars"
  USING (app_row_visible("user_id")) WITH CHECK (app_row_visible("user_id"));--> statement-breakpoint

ALTER TABLE "meeting_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "meeting_records" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- meeting_records.user_id é nullable (bot sem dono conhecido): linhas com NULL só
-- são visíveis sob bypass de sistema (webhook/cron), nunca por um usuário.
CREATE POLICY "meeting_records_isolation" ON "meeting_records"
  USING (app_row_visible("user_id")) WITH CHECK (app_row_visible("user_id"));--> statement-breakpoint

ALTER TABLE "billing_deposits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_deposits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "billing_deposits_isolation" ON "billing_deposits"
  USING (app_row_visible("user_id")) WITH CHECK (app_row_visible("user_id"));--> statement-breakpoint

ALTER TABLE "usage_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_ledger" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "usage_ledger_isolation" ON "usage_ledger"
  USING (app_row_visible("user_id")) WITH CHECK (app_row_visible("user_id"));--> statement-breakpoint

-- Privilégios mínimos para a role da aplicação nas tabelas tenant.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "user_calendars", "user_wallets", "signature_requests", "notifications",
  "wallet_link_nonces", "meeting_records", "billing_deposits", "usage_ledger"
  TO app_user;
