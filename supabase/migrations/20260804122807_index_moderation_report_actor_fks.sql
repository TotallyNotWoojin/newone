begin;

-- These nullable actor references are used for scoped joins and deletion
-- checks. PostgreSQL does not create indexes for referencing-side foreign keys.
create index message_reports_assigned_by_fk_idx
  on private.message_reports (organization_id, assigned_by_user_id);

create index message_reports_assigned_investigator_fk_idx
  on private.message_reports (organization_id, assigned_investigator_user_id);

create index message_reports_closed_by_fk_idx
  on private.message_reports (organization_id, closed_by_user_id);

commit;
