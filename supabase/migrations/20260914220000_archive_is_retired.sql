-- Archive is retired (owner, Sep 14 2026): the app no longer offers it on a
-- row, in the chips or in a group's controls, and every chat that was archived
-- -- a group archived by its manager, or a chat a reader archived for
-- themselves -- goes back into the list for everyone. The columns and the
-- commands stay so a build that still knows archive keeps working; nothing in
-- the current app writes them.
update public.conversations
set is_archived = false
where is_archived;

update public.conversation_preferences
set is_archived = false
where is_archived;
