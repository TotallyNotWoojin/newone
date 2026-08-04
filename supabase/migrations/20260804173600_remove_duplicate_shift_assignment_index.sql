begin;

-- The foundation index and the later current-shift audience index had the
-- same keys and predicate. Keep the original canonical name so query plans
-- retain identical coverage without paying twice for every assignment write.
drop index if exists public.shift_assignments_org_user_current_idx;

commit;
