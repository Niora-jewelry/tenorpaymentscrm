# Agreements (e-signature)

The merchant agreement (Maverick, v1.8) filled from the CRM, sent for
e-signature through SignWell, tracked by webhook, and filed back on the
record signed. Spec: *CRM Auto-Agreement Send — Build Spec* (27 Oct 2026)
with the client's rulings of 30 Oct 2026.

## Where things live

| What | Where |
|---|---|
| The rules for one agreement kind (PDF field ↔ CRM field, fixed values, signature spots, pre-send checks) | `src/lib/agreements/kinds/maverickMerchant.ts` — a second kind (the ACH agreement) is another file like it plus a row in `agreement_kinds` |
| The template PDF and its field map | `src/lib/agreements/template/` — built by `scripts/build-agreement-template.mjs` |
| Who signs | `signers.ts` — 25% or more, then the next largest until 51%, max 4 |
| Fill + flatten, signature rectangles | `pdf.ts` |
| The vendor | `vendor/signwell.ts` behind `vendor/types.ts` (`ESignVendor`) |
| Send, void, remind, resend to one signer, the panel, the PDF | `service.ts` |
| Webhook handling and the status machine | `webhook.ts` + SQL `agreement_apply_event` (migration 9839) |
| Signed-PDF download with retry | `download.ts` (per-minute `/api/mail/tick`), daily expiry/reconcile in `housekeeping.ts` |

Status moves forward only: `sent → viewed → partially_signed → completed`,
or to `declined`, `expired`, `voided`. A terminal status absorbs anything
after it; a repeated webhook is a no-op (`agreement_events.dedupe_key`).

## Setting SignWell up (once)

The account is opened under **Tenor Payments** (the client, 30 Oct 2026);
both deployments (TapDash and Tenor) share the database, so one account and
one webhook serve both — the webhook posts to **one** URL and the row it
updates is the same either way.

1. Create the SignWell account; in **API → API keys** create a key.
2. In **API → Webhooks** add `https://<deployment>/api/agreements/webhooks/signwell`
   (pick the deployment that will always be up — Tenor's). Note the
   **webhook id** SignWell shows: it is the HMAC key every event is signed
   with.
3. On **both** Vercel projects set:
   - `SIGNWELL_API_KEY`
   - `SIGNWELL_WEBHOOK_ID`
   - `SIGNWELL_TEST_MODE` — leave unset (or `true`) until the coordinate
     check below passes; then `false` on production only. Outside
     production test mode is forced on.
4. Redeploy. Admin → Presets → Agreements shows "connected" and the sender
   name / email / subject / message.

## Before the first real send: the coordinate check

SignWell places a field by `x`/`y` from the page's top-left in CSS pixels
(96 dpi); the template's rectangles are PDF points from the bottom-left and
`vendor/signwell.ts` converts (`y = (pageHeight − (y + h)) × 4/3`, same for
x, width and height). Checked on 30 Oct 2026 with a draft test-mode
document — the boxes sit on the signature lines. Re-check after any
template change:

1. On a test record with one owner at 100%, Send agreement.
2. Open the signing link SignWell emails. The signature box must sit on the
   "PRINCIPAL 1" line of page 4 (Merchant Acceptance), the date box beside
   it, and the same on page 5 (Personal Guarantee and Bank Disclosure).
3. If they are off by a constant, the unit is wrong (points vs pixels) —
   adjust the conversion in `vendor/signwell.ts` and re-test.

## Permissions

- `agreements.send` (Admin → Permissions → Agreements): Send, Void,
  Void & resend, Send reminder, Resend to a signer. On by default for Sales
  agent, Underwriter, Customer service, Admin; Super admin always.
- Anyone who can open the record and its Agreements tab sees the panel.
- A PDF (the copy that went out, the signed one) opens only for someone who
  can see **every** field printed on it — the Private sub-tab's SSN, EIN and
  bank fields among them — so a Sales agent who sent it may not be able to
  open it. That is the spec's rule, not a bug.

## What the client still has to decide

- Nothing blocks sending. The ACH agreement (phase 2) needs its own kind
  file; its sheet's open points are in the plan.
