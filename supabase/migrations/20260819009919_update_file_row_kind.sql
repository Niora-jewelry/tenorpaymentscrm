-- Files on an Update (client, 6 Nov 2026: "Unable to add files"). A new attachment
-- point, like a case's. On its own because a new enum value can't be used in the
-- transaction that adds it; 9920 is what uses it.
alter type file_row_kind add value if not exists 'update_post';
