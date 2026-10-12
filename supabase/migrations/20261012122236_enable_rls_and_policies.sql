-- Step 4: RLS Policies and Column Privileges

-- Profiles: Column-level privilege restriction
REVOKE UPDATE ON public.profiles FROM PUBLIC, anon, authenticated;
GRANT UPDATE (sender_name, sender_phone, updated_at) ON public.profiles TO authenticated;

CREATE POLICY "profiles_select" ON public.profiles FOR SELECT
  USING ((select auth.uid()) = id OR is_admin());
CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE
  USING ((select auth.uid()) = id)
  WITH CHECK ((select auth.uid()) = id);

-- Credit Ledger
CREATE POLICY "credit_ledger_select" ON public.credit_ledger FOR SELECT
  USING ((select auth.uid()) = user_id OR is_admin());

-- Topups
CREATE POLICY "topups_select" ON public.topups FOR SELECT
  USING ((select auth.uid()) = user_id OR is_admin());

-- Jobs
CREATE POLICY "jobs_select" ON public.jobs FOR SELECT
  USING ((select auth.uid()) = user_id OR is_admin());

-- Job Events
CREATE POLICY "job_events_select" ON public.job_events FOR SELECT
  USING ((select auth.uid()) = user_id OR is_admin());

-- Plans & Quotes
CREATE POLICY "plans_quotes_select" ON public.plans_quotes FOR SELECT
  USING ((select auth.uid()) = user_id OR is_admin());

-- Conversations
CREATE POLICY "conversations_select" ON public.conversations FOR SELECT
  USING ((select auth.uid()) = user_id OR is_admin());
CREATE POLICY "conversations_insert" ON public.conversations FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "conversations_update" ON public.conversations FOR UPDATE
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "conversations_delete" ON public.conversations FOR DELETE
  USING ((select auth.uid()) = user_id);

-- Messages
CREATE POLICY "messages_select" ON public.messages FOR SELECT
  USING ((select auth.uid()) = user_id OR is_admin());
CREATE POLICY "messages_insert" ON public.messages FOR INSERT
  WITH CHECK (
    (select auth.uid()) = user_id
    AND role = 'user'
    AND plan IS NULL
    AND quote IS NULL
    AND clarification_items IS NULL
  );

-- Notes
CREATE POLICY "notes_select" ON public.notes FOR SELECT
  USING ((select auth.uid()) = user_id);
CREATE POLICY "notes_insert" ON public.notes FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "notes_update" ON public.notes FOR UPDATE
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
CREATE POLICY "notes_delete" ON public.notes FOR DELETE
  USING ((select auth.uid()) = user_id);

-- Artifact Versions
CREATE POLICY "artifact_versions_select" ON public.artifact_versions FOR SELECT
  USING ((select auth.uid()) = user_id OR is_admin());

-- Notifications
CREATE POLICY "notifications_select" ON public.notifications FOR SELECT
  USING ((select auth.uid()) = user_id);
CREATE POLICY "notifications_update" ON public.notifications FOR UPDATE
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- Admin Audit Log
CREATE POLICY "admin_audit_log_select" ON public.admin_audit_log FOR SELECT
  USING (is_admin());

-- Provider Costs
CREATE POLICY "provider_costs_select" ON public.provider_costs FOR SELECT
  USING (is_admin());

-- Settings Public
CREATE POLICY "settings_public_select" ON public.settings_public FOR SELECT
  USING (true);
CREATE POLICY "settings_public_admin" ON public.settings_public FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());

-- Capability Registry
CREATE POLICY "capability_registry_select" ON public.capability_registry FOR SELECT
  USING (true);
CREATE POLICY "capability_registry_admin" ON public.capability_registry FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());

-- LLM Usage
CREATE POLICY "llm_usage_select" ON public.llm_usage FOR SELECT
  USING (is_admin());

-- Templates
CREATE POLICY "templates_select" ON public.templates FOR SELECT
  USING (true);
CREATE POLICY "templates_admin" ON public.templates FOR ALL
  USING (is_admin())
  WITH CHECK (is_admin());

-- Capability Requests
CREATE POLICY "capability_requests_select" ON public.capability_requests FOR SELECT
  USING ((select auth.uid()) = user_id OR is_admin());
CREATE POLICY "capability_requests_insert" ON public.capability_requests FOR INSERT
  WITH CHECK ((select auth.uid()) = user_id);
