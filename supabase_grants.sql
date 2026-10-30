-- ניהול משק בית — הרשאות API לטבלאות חדשות (שינוי של Supabase מ-30.10.2026)
-- בטוח להריץ כמה פעמים. טבלה שלא קיימת פשוט מדולגת.
-- מריצים ב-Supabase → SQL Editor, בפרויקט "my budget".
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['households','household_members','push_subscriptions']
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO anon', t);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated, service_role', t);
      RAISE NOTICE 'granted: %', t;
    ELSE
      RAISE NOTICE 'skipped (no such table): %', t;
    END IF;
  END LOOP;
END $$;
-- ההרשאות האלה לא עוקפות את RLS — מדיניות האבטחה הקיימת ממשיכה לקבוע מי רואה מה.
