# Team Assignment

Client spec of 29 Oct 2026. Migrations 9843 to 9845 hold the rules; this folder is a thin layer on them.

## The model

- A team is a user type. "Reconciler" in the spec is the Accounting type. `permission_templates.team_label` holds "Underwriting".
- `record_team_assignments` has one row per team on a record. `taken_by` null means Open.
- `team_members_assigned` is still the field that grants visibility. Taking an assignment adds the person to it, so "after it's taken, the normal rules apply" needs nothing new.
- `team_assignments_reconcile` keeps the rows in step with the field, from the trigger that already follows the field. Every writer of the field stays correct: create, bulk edit, offboarding, a change of user type.

## Three levels of sight

| Level | How you get it | What you can do |
|---|---|---|
| Rules | Module access, Only mine, admin | Everything your grants allow |
| Open | See open records + Can view open items | Open it, read only until taken |
| List | See open records alone | A list row and Assign to me, no drawer |

- `record_listable` answers "may this be a row in my list". `records_filterable`, `record_values_for` and `record_modules` use it. The `records` policy uses `record_row_listable`, the same rules without looking the row up, because during `INSERT ... RETURNING` the row is not there yet.
- `record_visible` answers "may I open it". Every child table stays on it.
- `record_writable` answers "may I change it". The write functions that skip field and tab grants ask it; a test fails if a later migration undoes one. `records_read_only` is the same answer for the app's own grant chain.

## Hidden means absent

- `team_assignment_view` is the only reader of the table. It leaves out what the viewer may not see, and `open` is null when they get no indication.
- `viewer_hidden_assignees` strips people from the field's value, in `record_values_for` and `records_filterable`, so a hidden person is not in the page.
- `updates` and `record_activity` carry `team_id` and `names_person`, and their policies apply the same rules. A person never hides from themselves.

## Decisions the spec left open

- See open records and Can view open items only ADD sight. A record someone can already reach by the normal rules stays reachable, or a sales agent's own record would vanish when it was assigned to Underwriting.
- An `open` viewer can read but not edit until they take it, because the setting is "Can view".
- Someone with See open records but not See users still gets the Open tag. Being shown the record for being open already tells them so.
- Twelve live records had two people from one team before this feature. Both stay, and the first is the taker. If the taker is removed, the next person takes over; only then does it go back to Open.
- A bulk edit of the field is admin only, because it replaces the people around the team rules.
