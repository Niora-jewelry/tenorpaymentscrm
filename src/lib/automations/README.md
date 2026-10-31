# Automations

Client spec of 30 Oct 2026. Migrations 9847 to 9853 hold the rules; this folder is the layer on them.

## How a run goes

1. A person does something. A trigger on the table that changed calls `automation_fire`, which queues the event for every live automation listening. With nothing switched on, each capture stops at one lookup of `automation_triggers`.
2. The tick (`/api/automations/tick`, every minute) calls `automation_work`. It starts what is queued, checks conditions once, and carries runs as far as they can go.
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
