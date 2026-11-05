'use client';

/**
 * Group texts: a list on the left, the open conversation on the right. Replies
 * appear on Refresh, which the client has said is fine for this screen. The bell
 * says when one has arrived.
 */
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, StatusPill } from '@/proto/ui/kit';
import { formatDateTime } from '@/proto/ui/tokens';
import type { Contact } from '@/lib/phone/contacts';
import type { GroupMember, GroupView } from '@/lib/phone/groups';
import { MAX_GROUP_MEMBERS, MIN_GROUP_MEMBERS, splitNumbers } from '@/lib/phone/bulkRules';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import { MAX_BODY_LENGTH } from '@/lib/phone/segments';
import { addGroupMemberAction, closeGroupAction, createGroupAction, removeGroupMemberAction, sendGroupMessageAction } from './bulkActions';
import { contactRows, RecipientPicker, type PickRow } from './RecipientPicker';

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-[12px] text-danger">
      <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function GroupTexts({
  allowed,
  myNumber,
  contacts,
  groups,
}: {
  allowed: boolean;
  myNumber: string | null;
  contacts: Contact[];
  groups: GroupView[];
}) {
  const rows = useMemo(() => contactRows(contacts), [contacts]);
  const [selected, setSelected] = useState<string | null>(groups[0]?.id ?? null);
  const [creating, setCreating] = useState(false);
  const router = useRouter();
  const group = groups.find((g) => g.id === selected) ?? groups[0] ?? null;

  const newGroupButton = allowed ? (
    <Button size="sm" icon="plus" onClick={() => setCreating(true)}>
      New group
    </Button>
  ) : null;

  if (creating) {
    return (
      <NewGroup
        rows={rows}
        myNumber={myNumber}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setSelected(id);
          router.refresh();
        }}
      />
    );
  }

  if (groups.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center">
        <p className="text-[13px] text-ink-700">No group texts yet.</p>
        <p className="mx-auto mt-1 max-w-md text-[12px] text-ink-500">
          A group holds {MIN_GROUP_MEMBERS} to {MAX_GROUP_MEMBERS} people on US or Canada local numbers, and everyone can see each other’s numbers.
        </p>
        {newGroupButton ? <div className="mt-3 flex justify-center">{newGroupButton}</div> : null}
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)] lg:items-start">
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2">
          {newGroupButton ?? <span />}
          <Button size="sm" variant="ghost" icon="refresh-cw" onClick={() => router.refresh()}>
            Refresh
          </Button>
        </div>
        <ul className="mt-2 max-h-[420px] space-y-1 overflow-y-auto pr-1">
          {groups.map((g) => {
            const last = g.messages[g.messages.length - 1];
            const on = group?.id === g.id;
            return (
              <li key={g.id}>
                <button
                  type="button"
                  aria-current={on ? 'true' : undefined}
                  onClick={() => setSelected(g.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-600 ${
                    on ? 'border-brand-200 bg-brand-50' : 'border-transparent hover:bg-canvas'
                  }`}
                >
                  <span className="block truncate text-[13px] font-medium text-ink-900">{g.name}</span>
                  <span className="mt-0.5 block truncate text-[12px] text-ink-500">
                    {last ? (last.body ?? 'Attachment') : `${g.members.length} people`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {group ? <Conversation key={group.id} group={group} onClosed={() => setSelected(null)} /> : null}
    </div>
  );
}

function NewGroup({
  rows,
  myNumber,
  onClose,
  onCreated,
}: {
  rows: PickRow[];
  myNumber: string | null;
  onClose: () => void;
  onCreated: (groupId: string) => void;
}) {
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const typed = useMemo(() => splitNumbers(pasted), [pasted]);
  const count = picked.size + typed.length;
  const nameOf = useMemo(() => new Map(rows.map((r) => [r.e164, r.name])), [rows]);

  const create = () =>
    start(async () => {
      setError(null);
      const result = await createGroupAction({
        name,
        members: [...[...picked].map((number) => ({ number, name: nameOf.get(number) ?? null })), ...typed.map((number) => ({ number }))],
      });
      if (result.ok) onCreated(result.groupId);
      else setError(result.message);
    });

  return (
    <div className="max-w-xl space-y-3 rounded-xl border border-line bg-canvas/40 p-3.5" data-new-group>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-ink-900">New group</h3>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="grid size-6 place-items-center rounded-md text-ink-400 transition-colors hover:bg-white hover:text-ink-900"
        >
          <Icon name="x" size={13} />
        </button>
      </div>
      {!myNumber ? <p className="text-[12.5px] text-ink-600">You have no phone number assigned, so you cannot start a group yet. Ask an administrator.</p> : null}

      <label className="block text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">
        Name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={60}
          disabled={pending}
          placeholder="Only you see this name"
          className="mt-1 block w-full rounded-lg border border-line bg-white px-2.5 py-2 text-[13px] font-normal normal-case tracking-normal text-ink-900 outline-none focus-field"
        />
      </label>

      <RecipientPicker
        rows={rows}
        picked={picked}
        onChange={setPicked}
        disabled={pending}
        pasted={pasted}
        onPaste={setPasted}
        pasteLabel="Or type numbers"
        pastePlaceholder="One per line"
      />

      <p className="text-[12px] text-ink-500">
        {MIN_GROUP_MEMBERS} to {MAX_GROUP_MEMBERS} people, US or Canada local numbers only. Everyone in the group can see each other’s numbers.
      </p>
      {error ? <Problem>{error}</Problem> : null}

      <div className="flex items-center justify-between gap-2">
        <span className={`text-[12px] tabular ${count > MAX_GROUP_MEMBERS ? 'font-medium text-danger' : 'text-ink-500'}`}>
          {count} of {MAX_GROUP_MEMBERS} people
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={pending || !name.trim() || !myNumber || count < MIN_GROUP_MEMBERS || count > MAX_GROUP_MEMBERS}
            onClick={create}
          >
            {pending ? 'Creating…' : 'Create group'}
          </Button>
        </div>
      </div>
    </div>
  );
}

const memberLabel = (m: GroupMember) => m.name ?? formatPhoneDisplay(m.e164);

function Conversation({ group, onClosed }: { group: GroupView; onClosed: () => void }) {
  const [body, setBody] = useState('');
  const [addNumber, setAddNumber] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const names = useMemo(() => new Map(group.members.map((m) => [m.e164, memberLabel(m)])), [group.members]);

  const act = (work: () => Promise<{ ok: true } | { ok: false; message: string }>, then?: () => void) =>
    start(async () => {
      setError(null);
      const result = await work();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      then?.();
      router.refresh();
    });

  const send = () => {
    const text = body.trim();
    if (!text || pending) return;
    act(() => sendGroupMessageAction({ groupId: group.id, body: text }), () => setBody(''));
  };

  return (
    <div className="min-w-0 rounded-xl border border-line-soft" data-group-conversation>
      <div className="border-b border-line-faint px-3.5 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="truncate text-[13.5px] font-semibold text-ink-900">{group.name}</h3>
          {group.canManage ? (
            closing ? (
              <span className="flex flex-wrap items-center gap-2 text-[12px] text-ink-600">
                Close this group for good?
                <Button size="sm" variant="danger" disabled={pending} onClick={() => act(() => closeGroupAction({ groupId: group.id }), onClosed)}>
                  Close group
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setClosing(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <button type="button" onClick={() => setClosing(true)} className="text-[12px] font-medium text-ink-500 hover:text-danger">
                Close group
              </button>
            )
          ) : (
            <StatusPill label="Read only" dot={false} />
          )}
        </div>
        <p className="mt-0.5 text-[11.5px] tabular text-ink-400">From {formatPhoneDisplay(group.fromE164)}</p>

        <ul className="mt-2 flex flex-wrap items-center gap-1.5">
          {group.members.map((m) => (
            <li key={m.id} className="flex items-center gap-1 rounded-full border border-line bg-canvas/40 py-0.5 pl-2.5 pr-1 text-[12px] text-ink-800" title={formatPhoneDisplay(m.e164)}>
              {memberLabel(m)}
              {group.canManage ? (
                removing === m.id ? (
                  <span className="ml-1 flex items-center gap-1">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => act(() => removeGroupMemberAction({ groupId: group.id, memberId: m.id }), () => setRemoving(null))}
                      className="rounded-full px-1.5 text-[11.5px] font-medium text-danger hover:underline"
                    >
                      Remove
                    </button>
                    <button type="button" onClick={() => setRemoving(null)} className="rounded-full px-1.5 text-[11.5px] text-ink-500 hover:underline">
                      Keep
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Remove ${memberLabel(m)}`}
                    onClick={() => setRemoving(m.id)}
                    className="grid size-4 place-items-center rounded-full text-ink-400 transition-colors hover:bg-white hover:text-ink-900"
                  >
                    <Icon name="x" size={10} />
                  </button>
                )
              ) : null}
            </li>
          ))}
          {group.canManage && group.members.length < MAX_GROUP_MEMBERS ? (
            <li>
              {adding ? (
                <form
                  className="flex items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act(() => addGroupMemberAction({ groupId: group.id, member: { number: addNumber } }), () => {
                      setAddNumber('');
                      setAdding(false);
                    });
                  }}
                >
                  <input
                    type="tel"
                    value={addNumber}
                    onChange={(e) => setAddNumber(e.target.value)}
                    aria-label="Number to add"
                    placeholder="(732) 724-1779"
                    autoFocus
                    disabled={pending}
                    className="h-6 w-32 rounded-md border border-line bg-white px-2 text-[12px] tabular outline-none focus-field"
                  />
                  <Button size="sm" type="submit" disabled={pending || !addNumber.trim()}>
                    Add
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => setAdding(false)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <button type="button" onClick={() => setAdding(true)} className="rounded-full px-2 py-0.5 text-[12px] font-medium text-brand-700 hover:underline">
                  + Add person
                </button>
              )}
            </li>
          ) : null}
        </ul>
      </div>

      <ul className="max-h-[340px] space-y-2 overflow-y-auto px-3.5 py-3" aria-label="Messages">
        {group.messages.length === 0 ? <li className="py-4 text-center text-[12.5px] text-ink-500">No messages yet. Say hello below.</li> : null}
        {group.messages.map((m) => {
          const mine = m.direction === 'out';
          return (
            <li key={m.id} className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
              <div className={`max-w-[85%] rounded-xl px-3 py-1.5 text-[13px] ${mine ? 'bg-brand-50 text-ink-900' : 'bg-canvas text-ink-900'}`}>
                {!mine ? <span className="mb-0.5 block text-[11.5px] font-semibold text-ink-600">{names.get(m.authorE164 ?? '') ?? formatPhoneDisplay(m.authorE164 ?? '')}</span> : null}
                {m.body ? <span className="whitespace-pre-wrap break-words">{m.body}</span> : null}
                {m.hasMedia ? <span className="block text-[12px] italic text-ink-500">Sent a photo or file. These do not show in the CRM yet.</span> : null}
              </div>
              <span className="mt-0.5 flex items-center gap-1.5 text-[11px] tabular text-ink-400">
                {formatDateTime(m.sentAt)}
                {m.status === 'failed' ? <span className="font-medium text-danger">Not sent</span> : null}
              </span>
            </li>
          );
        })}
      </ul>

      {error ? <div className="px-3.5 pb-2"><Problem>{error}</Problem></div> : null}

      {group.canManage ? (
        <div className="flex items-end gap-2 border-t border-line-faint p-2.5">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            maxLength={MAX_BODY_LENGTH}
            aria-label={`Message to ${group.name}`}
            placeholder="Everyone in the group sees this"
            className="min-w-0 flex-1 resize-y rounded-lg border border-line bg-white px-2.5 py-2 text-[13px] text-ink-900 outline-none focus-field"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <Button size="sm" variant="primary" icon="send" disabled={pending || !body.trim()} onClick={send}>
            {pending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
