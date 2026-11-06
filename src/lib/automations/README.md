# Automations

Client spec of 30 Oct 2026, with Files Required and Lock & Hide (1 Nov). Migrations 9847 to 9862 and 9891 hold the rules; this folder is the layer on them.

## How a run goes

1. A person does something. A trigger on the table that changed calls `automation_fire`, which queues the event for every live automation listening. With nothing switched on, each capture stops at one lookup of `automation_triggers`.
2. The tick (`/api/automations/tick`, every minute) calls `automation_work`. It starts what is queued, checks conditions once, and carries runs as far as they can go. A click on Awaiting client does the same at once (`runAutomationsNow`), so the ticket has changed by the time the page refreshes. Waits still end on the tick. When the tick stops, nothing errors: `automationBacklog` counts what is over five minutes late, and the Automations and Run history pages say so.
3. An action and its history commit together, in SQL. Each step has its own exception block: a failed step rolls back alone, the run stops, and earlier steps stand.
4. Send email is the one step that leaves the database. The run parks as `sending`, `engine.ts` builds and queues the message, and `done`/`fail` in the mail sender report back through `automation_mail_result`.

A step's type lives in `steps.ts`, shared by the server and the builder. Modules, tabs and fields are ids and keys, never names.

## The rules, and where each is held

| Spec | Held by |
|---|---|
| Future events only | `automation_triggers` has rows only while Test or On, with `active_from` |
| No chaining | `tapdash.automation` is on during a run; the tick also has no signed-in user |
| People only | `automation_person`: a signed-in user, or `tapdash.event_actor`, which the application writer sets |
| Full access | Actions write directly, with no gate |
| Stop on a skip or failure | `automation_advance`, then `automation_stop_run` |
| No re-check after a wait | Conditions are read only in `automation_start` |
| Finish on old or new version | A run keeps its `version_id`; `automation_move_runs` moves it by step id |
| Test | `only_record` on the trigger row |

## Which module a change happened in

Write functions don't take a module, so the server client sends the page path as `x-tapdash-page` (from the Referer) and `automation_page_module` reads it. It decides nothing about access. A change made away from a module page (the dashboard, a merchant through an application) has no module: Only in module is false for it, and Change pipeline stage uses its pipeline's own module.

## Emails and records

- `record_contact_emails` holds the main contact (the first in the Contacts group, the one the drawer marks Primary) and every owner, kept by a trigger on `records`.
- One email is one event, however many connected mailboxes it reached. Mail older than a day, or stored while a mailbox was seeding, is history.
- An automation's own email is recognised by `internet_message_id` on its outbox row.
- On an address shared by several records, Composer asks which is the main record (`mail_record_choices`), and that goes on the outbox row. The first send links the conversation (`mail_record_links`), so replies follow it and nobody is asked twice.

## Decisions the spec left open

- **Conditions come right after the triggers.** The spec says waits can go anywhere after the trigger, and also that conditions are checked once, when it starts. A condition after a wait would never mean what it reads as, so the builder doesn't allow it.
- **Brackets go one level deep**, with one join between groups.
- **A record already partway through an automation doesn't start it a second time.** Two runs would send the merchant the same email twice. The history says so.
- **Off ends what was waiting.** Off is "not running", and an admin turning something off wants it stopped. The builder warns first.
- **A team already on the record, or a person already assigned, counts as done**, and the run carries on: the step's aim is met. A team taken by someone else is a skip, following the team rules.
- **An email an empty Files row should have attached doesn't go**, and the run stops with an alert. An email promising a voided check must not go without one.
- **A sensitive field can't be an email variable**, even typed in by hand. SSNs don't belong in email.
- **Create ticket:** Title falls back to the Issue. The ticket's managers are the people on the record, then the builder, then an admin, because only a manager or admin can close one.
- **Send notification** has an optional message, so a notification can say something. Empty, it names the automation.
- **Application received** fires for an online Submit and for a returned PDF that was recorded, once per application.
- **Module assigned on Tickets** fires when a person opens a case, since the case rule is the only way a record gets there.
- **"Happened in" for Module assigned** is the module added or removed, not the page.
- **Who can switch one off:** whoever has Full edit on Automations can always, as they could turn the whole thing off.
- **Automation entries in Updates show to everyone with the tab, even on Only mine.** They are the record's history, not someone's post. Team rules still hide an assignment entry.
- **"Today" in Days from date is New York time.** One line in `automation_today`.
- **An inbound email on a shared address with no chosen record runs on nothing**, and run history says why. The spec only covers the person writing an email.

## Lock, Hide, Unlock, Unhide, and File uploaded

- A lock or hide is a row in `record_restrictions` per item per record (`tab:<key>`, `subtab:<id>`, `field:<key>`, `notes:<tab key>`, `row:<id>`). Nobody's permissions change: `user_record_scope_grant` and `user_record_field_grant` cap the normal grant by what is active, so every policy, write and @mention obeys it, and lifting one leaves exactly what was under it.
- Adding goes by the normal grant (`record_tab_base_grant`): a lock or hide doesn't stop someone adding logins, files, rows or statements, and covers what they add.
- Which tabs can be picked, and how deep, is `tabs.restriction_level`, not code.
- File uploaded fires from `record_file_upload` and `move_file` for preset rows, for a person only. It waits for the uploads to stop: the queue row is held by `not_before`, and each further file from that person to that row pushes it back a minute, so one batch is one run and its conditions read the finished row. `automation_file_fires` remembers the last fire per row for the two "first upload" options.

### Decisions the spec left open

- **A lock or hide stops someone with Allow download = No from opening the file as well as saving it.** A file opened in the browser is a download by another name. Approved by Izzy, 3 Nov.
- **Unlocking by hand: the person chooses what to unlock** from what that action covered (Izzy, 3 Nov). The item clicked starts ticked. Choosing an item also takes off any other lock of that kind on it.
- **Re-lock and Re-hide are on a bar above the tabs**, since the item's icon has gone once it is lifted. Only the action's groups see it. Approved by Izzy, 3 Nov.
- **A user-added row picked by an automation can't be**, as with Mark file required: actions name preset rows.
- **Deal Name isn't offered**: the permissions spec says it is never hidden.

## Ticket automations (Ticket Automation Flow Builder spec, 1 Nov 2026)

A second builder on the same engine. `automations.kind` is `record` or `ticket`, set when it is created and never changed; `OFFERED[kind]` in `steps.ts` is what each builder shows, and `problemsIn(steps, kind)` refuses a step from the other one. A ticket is a case: number, title, Issue, open or closed. Migrations 9893 and 9894.

| Spec | Where |
|---|---|
| Awaiting client button, tag, permission, log by name | `set_awaiting_client` (the gate: can open the ticket + `action.awaiting_client`, default Yes for every type); `cases.awaiting_client_at/by`; `CasesPanel` |
| The click starts flows on that ticket only; a tagged ticket starts nothing | `set_awaiting_client` queues with `case_id`; returns false when already tagged; `setAwaitingClientAction` runs them straight away. Clearing the tag by hand starts nothing |
| Email received in a chosen inbox; one inbox per flow | trigger `ticket_capture_mail` on `mail_messages`, match `{mailbox}`; `ticketProblems` |
| Matching by main contact or owner | `record_contact_emails`, as record automations |
| Emails always reach the Communication tab | `ticket_capture_mail` copies to `messages` for any inbox a ticket automation names (`ticket_inbox`), whatever its status |
| No matching record: nothing runs, nothing is created | `automation_start_ticket` → `not_matched` with the reason |
| And ticket is open / not open; Email connects to a record | `automation_ticket_condition`; exactly one ticket condition on an email flow (`ticketProblems`) |
| Choosing a ticket for an email | `automation_start_ticket` → status `choosing` + `ticket_choices`; `ticket_choices_for` (Vital Info, `TicketChoiceNote`), `ticket_choice_records` (row badge), `ticket_choose`; asked = managers of the open tickets, else anyone who can open the record in Tickets (`ticket_choice_for_me`) |
| Expires after 24 hours | `automation_work` → status `expired`, "Expired: no ticket chosen." |
| A wait ends when the client emails, in any inbox | `ticket_capture_mail` → `cancelled`, "Cancelled: client replied." |
| Send merchant an email, recorded in Communication and on the ticket | the record send path; `automation_mail_result` writes `messages` and `case_log` for ticket flows; `{Ticket title}` `{Ticket number}` `{Email subject}` `{Email body}` |
| Close ticket, "Closed by Automation"; closed already = skip | `automation_close_ticket` |
| Notify user, including a specific user | `automation_send_notification` (`who = 'user'`), notification carries `case_id` |
| Create a team assignment | the record's team assignment, which is the ticket's row in Tickets |
| Open ticket, only with And ticket is not open; later steps act on it | `automation_open_ticket` sets `automation_runs.case_id` |
| Clear Awaiting client; not set = skip | `automation_clear_awaiting` |
| Every action logged on the ticket and in Updates | `case_log` (`case_log_write`) and `automation_log` |
| Test on one ticket | `automations.test_case_id`; `automation_set_status(..., p_test_case)` |

### Decisions the spec left open

- **Close ticket keeps a Solution a person already wrote.** A case can't close without one; an empty one becomes "Closed by Automation". Overwriting someone's words would lose them.
- **Create a team assignment is the record's assignment.** Assignments live on the record, and the record is the ticket's row in Tickets; the ticket's log says it was done.
- **A ticket inbox's copies go to every record the sender belongs to**, and show under the Communication tab's own rule (`communication.scope`): Org sees them, Own only sees mail of their own inboxes.
- **Choosing is asked only when a step needs one ticket** (Close ticket, Create a team assignment, Clear Awaiting client, an email with ticket variables), as the spec lists. Otherwise the flow runs with no ticket.
- **Open ticket's Title and Issue fill four variables**: Email subject, Email body, Merchant name, Contact name. Anything else in braces is refused when saving.
