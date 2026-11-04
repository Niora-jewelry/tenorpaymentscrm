'use client';

/** New chat (direct or group) and New team. People come from Microsoft contacts and Tenor users. */
import { useCallback, useState } from 'react';
import { Button, Dialog } from '@/proto/ui/kit';
import type { AccountView } from '@/lib/msteams/types';
import { PeoplePicker } from '../../msteams-ui/shared';
import { searchPeopleAction } from '../../calendar/actions';
import { newChatAction, newTeamAction } from '../actions';

const field = 'mt-1 w-full rounded-md border border-line bg-white px-2 py-1.5 text-[13px] font-normal text-ink-800 outline-none focus:border-ink-500';
const labelClass = 'block text-[12px] font-semibold text-ink-600';

function useAccount(accounts: AccountView[]) {
  const [identityId, setIdentityId] = useState(accounts[0]?.identityId ?? '');
  const search = useCallback(
    async (q: string) => {
      const r = await searchPeopleAction({ identityId, q });
      return r.ok ? r.data : [];
    },
    [identityId],
  );
  const picker =
    accounts.length > 1 ? (
      <label className={labelClass}>
        Account
        <select value={identityId} onChange={(e) => setIdentityId(e.target.value)} className={field}>
          {accounts.map((a) => (
            <option key={a.identityId} value={a.identityId}>
              {a.email}
            </option>
          ))}
        </select>
      </label>
    ) : null;
  return { identityId, search, picker };
}

export function NewChatDialog({ accounts, onClose, onCreated }: { accounts: AccountView[]; onClose: () => void; onCreated: (key: string) => void }) {
  const { identityId, search, picker } = useAccount(accounts);
  const [people, setPeople] = useState<{ email: string; name?: string }[]>([]);
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    const r = await newChatAction({ identityId, emails: people.map((p) => p.email), topic: people.length > 1 ? topic : undefined });
    setBusy(false);
    if (r.ok) onCreated(r.data);
    else setError(r.message);
  };

  return (
    <Dialog title="New chat" onClose={onClose} width={520}>
      <div className="space-y-3">
        {picker}
        <div className={labelClass}>
          To
          <div className="mt-1 font-normal">
            <PeoplePicker picked={people} onChange={setPeople} search={search} placeholder="Search Microsoft contacts and Tenor users" />
          </div>
        </div>
        {people.length > 1 ? (
          <label className={labelClass}>
            Group name (optional)
            <input value={topic} maxLength={200} onChange={(e) => setTopic(e.target.value)} className={field} />
          </label>
        ) : null}
        <p className="text-[12px] text-ink-500">{people.length > 1 ? 'A group chat with everyone picked.' : 'One person makes a direct chat; more make a group chat.'}</p>
        {error ? <p className="text-[12.5px] font-medium text-[#b02a30]">{error}</p> : null}
        <div className="flex justify-end">
          <Button variant="primary" loading={busy} disabled={people.length === 0} onClick={() => void create()}>
            Start chat
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function NewTeamDialog({ accounts, onClose, onCreated }: { accounts: AccountView[]; onClose: () => void; onCreated: () => void }) {
  const { identityId, search, picker } = useAccount(accounts);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [people, setPeople] = useState<{ email: string; name?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    const r = await newTeamAction({ identityId, name, description, emails: people.map((p) => p.email) });
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    if (r.data.note) setNote(r.data.note);
    else onCreated();
  };

  if (note) {
    return (
      <Dialog title="Team created" onClose={onCreated}>
        <p className="text-[13px] text-ink-600">{note}</p>
      </Dialog>
    );
  }

  return (
    <Dialog title="New team" onClose={onClose} width={520}>
      <div className="space-y-3">
        {picker}
        <label className={labelClass}>
          Team name
          <input value={name} maxLength={256} autoFocus onChange={(e) => setName(e.target.value)} className={field} />
        </label>
        <label className={labelClass}>
          Description (optional)
          <input value={description} maxLength={1024} onChange={(e) => setDescription(e.target.value)} className={field} />
        </label>
        <div className={labelClass}>
          Members
          <div className="mt-1 font-normal">
            <PeoplePicker picked={people} onChange={setPeople} search={search} placeholder="Search Microsoft contacts and Tenor users" />
          </div>
        </div>
        <p className="text-[12px] text-ink-500">You are the team’s owner. Teams creates its General channel, and owners can add more.</p>
        {error ? <p className="text-[12.5px] font-medium text-[#b02a30]">{error}</p> : null}
        <div className="flex justify-end">
          <Button variant="primary" loading={busy} loadingLabel="Creating…" disabled={!name.trim()} onClick={() => void create()}>
            Create team
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
