'use client';

/**
 * Where an Update is written: real formatting as you type, @mentions, and files.
 *
 * Bold looks bold and a bullet is a bullet, with nothing to learn (client, 6 Nov
 * 2026). The stored body is still the plain text with markers (`richBody.ts`), so
 * `value` and `onChange` speak that text and nothing outside this file changes.
 * A reply keeps the plain `MentionTextarea`: it has no toolbar to need this.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor as TipTap } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { Icon, type IconName } from '@/proto/ui/icons';
import { Popover } from '@/proto/ui/kit';
import { UserAvatar } from './UserAvatar';
import { mentionIdsIn } from './MentionTextarea';
import { bodyToDoc, docToBody, linkAddress, type RichNode } from '@/lib/records/richBody';
import type { TeamRosterEntry } from '@/lib/records/updates';

// A bare "@" lists everyone who can be mentioned; typing narrows it.
const MENTION_PATTERN = /@(|[^\s@][^\n@]{0,39})$/;

type Query = { text: string; from: number; to: number };

export function RichComposer({
  value,
  onChange,
  roster,
  placeholder,
  disabled,
  onMentionsChange,
  initialMentions = [],
  onFiles,
  toolbarExtra,
}: {
  /** The stored text. Empty clears the editor; anything else only seeds it. */
  value: string;
  onChange: (v: string) => void;
  roster: TeamRosterEntry[];
  placeholder?: string;
  disabled?: boolean;
  /** The ids of the people tagged in the text, whenever that changes. */
  onMentionsChange?: (ids: string[]) => void;
  initialMentions?: TeamRosterEntry[];
  /** Files pasted or dropped on the text. */
  onFiles?: (files: File[]) => void;
  toolbarExtra?: React.ReactNode;
}) {
  const [query, setQuery] = useState<Query | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [picked, setPicked] = useState<TeamRosterEntry[]>(initialMentions);

  const matches = useMemo(() => {
    if (!query) return [];
    const q = query.text.toLowerCase();
    return roster.filter((m) => m.name.toLowerCase().startsWith(q) || m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q))).slice(0, 6);
  }, [query, roster]);

  // The editor's key handler is made once, so it reads these through a ref.
  const live = useRef({ matches, activeIndex, query, onFiles });
  useEffect(() => {
    live.current = { matches, activeIndex, query, onFiles };
  });

  const announce = useRef(onMentionsChange);
  useEffect(() => {
    announce.current = onMentionsChange;
  }, [onMentionsChange]);
  const taggedKey = mentionIdsIn(value, picked).join(',');
  useEffect(() => {
    announce.current?.(taggedKey ? taggedKey.split(',') : []);
  }, [taggedKey]);

  const readQuery = (e: TipTap) => {
    const { $from, empty, from } = e.state.selection;
    const before = empty ? $from.parent.textBetween(0, $from.parentOffset, '\n', '\0') : '';
    const m = before.match(MENTION_PATTERN);
    if (!m) return setQuery(null);
    setQuery({ text: m[1]!, from: from - m[1]!.length - 1, to: from });
    setActiveIndex(0);
  };

  const applyMention = useRef<(member: TeamRosterEntry) => void>(() => {});

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
        underline: false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          protocols: ['http', 'https', 'mailto'],
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
        },
      }),
      Placeholder.configure({ placeholder: placeholder ?? '' }),
    ],
    content: value ? (bodyToDoc(value) as object) : '',
    onUpdate: ({ editor: e }) => {
      onChange(docToBody(e.getJSON() as RichNode));
      readQuery(e);
    },
    onSelectionUpdate: ({ editor: e }) => readQuery(e),
    onBlur: () => setTimeout(() => setQuery(null), 120),
    editorProps: {
      attributes: { class: 'mail-editor-content', spellcheck: 'true', 'aria-label': 'Write an update', role: 'textbox', 'aria-multiline': 'true' },
      handleKeyDown: (_view, event) => {
        const { matches: list, activeIndex: at, query: open } = live.current;
        if (!open || !list.length) return false;
        if (event.key === 'ArrowDown') {
          setActiveIndex((i) => (i + 1) % list.length);
          return true;
        }
        if (event.key === 'ArrowUp') {
          setActiveIndex((i) => (i - 1 + list.length) % list.length);
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          applyMention.current(list[at]!);
          return true;
        }
        if (event.key === 'Escape') {
          setQuery(null);
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        const take = live.current.onFiles;
        if (!files.length || !take) return false;
        event.preventDefault();
        take(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        const take = live.current.onFiles;
        if (!files.length || !take) return false;
        event.preventDefault();
        take(files);
        return true;
      },
    },
  });

  useEffect(() => {
    applyMention.current = (member) => {
      const q = live.current.query;
      if (!editor || !q) return;
      editor.chain().focus().insertContentAt({ from: q.from, to: q.to }, `@${member.name} `).run();
      setPicked((l) => (l.some((p) => p.id === member.id) ? l : [...l, member]));
      setQuery(null);
    };
  }, [editor]);

  // Posting clears the draft from outside.
  useEffect(() => {
    if (editor && !value && !editor.isEmpty) editor.commands.clearContent();
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  if (!editor) return <div className="skeleton rounded-lg" style={{ height: 96 }} />;

  return (
    <div className="relative">
      <Toolbar editor={editor} extra={toolbarExtra} />
      <div
        className="mail-editor min-h-[64px] cursor-text rounded-lg border border-line px-3 py-2 transition-colors focus-within:border-brand-600/45 focus-within:shadow-[0_0_0_3px_rgba(29,78,216,.07)]"
        onClick={() => editor.commands.focus()}
      >
        <EditorContent editor={editor} />
      </div>
      {query && matches.length ? (
        <div className="absolute left-2 top-full z-10 mt-1 w-64 overflow-hidden rounded-lg border border-line bg-white shadow-[0_8px_24px_-8px_rgba(14,28,52,.25)]">
          {matches.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                applyMention.current(m);
              }}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] ${
                i === activeIndex ? 'bg-brand-50 text-brand-700' : 'text-ink-700 hover:bg-canvas'
              }`}
            >
              <UserAvatar userId={m.id} name={m.name} size={20} />
              {m.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Toolbar({ editor, extra }: { editor: TipTap; extra?: React.ReactNode }) {
  const on = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      code: e.isActive('code'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      link: e.isActive('link'),
    }),
  });
  const chain = () => editor.chain().focus();
  return (
    <div role="toolbar" aria-label="Formatting" className="mb-1 flex flex-wrap items-center gap-0.5">
      <Tool icon="type-bold" label="Bold (Ctrl+B)" active={on.bold} onPress={() => chain().toggleBold().run()} />
      <Tool icon="type-italic" label="Italic (Ctrl+I)" active={on.italic} onPress={() => chain().toggleItalic().run()} />
      <Tool icon="code" label="Code" active={on.code} onPress={() => chain().toggleCode().run()} />
      <LinkMenu editor={editor} active={on.link} />
      <span aria-hidden className="mx-1 h-4 w-px bg-line" />
      <Tool icon="list" label="Bulleted list" active={on.bullet} onPress={() => chain().toggleBulletList().run()} />
      <Tool icon="list-ordered" label="Numbered list" active={on.ordered} onPress={() => chain().toggleOrderedList().run()} />
      <Tool icon="quote" label="Quote" active={on.quote} onPress={() => chain().toggleBlockquote().run()} />
      {extra ? (
        <>
          <span aria-hidden className="mx-1 h-4 w-px bg-line" />
          {extra}
        </>
      ) : null}
    </div>
  );
}

/** `onMouseDown` so the text keeps its selection and focus. */
function Tool({ icon, label, active, onPress }: { icon: IconName; label: string; active?: boolean; onPress: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active ?? false}
      onMouseDown={(e) => {
        e.preventDefault();
        onPress();
      }}
      className={`grid size-7 cursor-pointer place-items-center rounded-md transition-colors ${
        active ? 'bg-brand-50 text-brand-700' : 'text-ink-400 hover:bg-canvas hover:text-ink-900'
      }`}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

function LinkMenu({ editor, active }: { editor: TipTap; active: boolean }) {
  const [url, setUrl] = useState('');
  const apply = (close: () => void) => {
    const typed = url.trim();
    if (!typed) editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else {
      const href = linkAddress(typed);
      if (editor.state.selection.empty && !active) {
        editor
          .chain()
          .focus()
          .insertContent([{ type: 'text', text: typed, marks: [{ type: 'link', attrs: { href } }] }, { type: 'text', text: ' ' }])
          .run();
      } else editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
    setUrl('');
    close();
  };
  return (
    <Popover
      width={280}
      trigger={() => (
        <span title="Link" className={`grid size-7 place-items-center rounded-md transition-colors ${active ? 'bg-brand-50 text-brand-700' : 'text-ink-400 hover:bg-canvas hover:text-ink-900'}`}>
          <Icon name="link" size={14} />
          <span className="sr-only">Link</span>
        </span>
      )}
    >
      {(close) => (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            apply(close);
          }}
          className="flex gap-1.5 p-1"
        >
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={active ? 'Leave empty to remove the link' : 'google.com'}
            aria-label="Link address"
            className="min-w-0 flex-1 rounded-md border border-line px-2 py-1 text-[12.5px] outline-none focus-field"
          />
          <button type="submit" className="cursor-pointer rounded-md bg-brand-900 px-2.5 text-[12px] font-semibold text-white">
            {url.trim() || !active ? 'Add' : 'Remove'}
          </button>
        </form>
      )}
    </Popover>
  );
}
