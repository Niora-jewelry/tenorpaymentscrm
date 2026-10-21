'use client';

/**
 * The message editor: TipTap with the formatting people actually use in
 * mail — bold, italic, underline, strike, colour, lists, quote, links,
 * emoji — and the browser's own spellcheck. Loaded only when a composer
 * opens (it is the heaviest thing on the page).
 *
 * Pasting or dropping an image does not embed it: it becomes an attachment,
 * which is how it reaches every recipient's mail client reliably.
 */
import dynamic from 'next/dynamic';
import { useImperativeHandle, useState, type Ref } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor as TipTap } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { Icon, type IconName } from '@/proto/ui/icons';
import { Popover } from '@/proto/ui/kit';

const EmojiPicker = dynamic(() => import('emoji-picker-react'), {
  ssr: false,
  loading: () => <p className="px-3 py-6 text-center text-[12px] text-ink-400">Loading emoji…</p>,
});

export type EditorHandle = {
  getHTML: () => string;
  isEmpty: () => boolean;
  insertHTML: (html: string) => void;
  focus: () => void;
};

const COLOURS = ['#08202f', '#b02a30', '#c07714', '#1a7a3c', '#1d4ed8', '#6b28ac', '#6b8699'];

export default function Editor({
  initialHTML,
  placeholder,
  onChange,
  onFiles,
  handleRef,
  minHeight = 220,
  toolbarExtra,
}: {
  initialHTML: string;
  placeholder: string;
  onChange: () => void;
  /** Images pasted or dropped into the text arrive here, as attachments. */
  onFiles?: (files: File[]) => void;
  handleRef: Ref<EditorHandle>;
  minHeight?: number;
  toolbarExtra?: React.ReactNode;
}) {
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          protocols: ['http', 'https', 'mailto', 'tel'],
          HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
        },
      }),
      TextStyleKit,
      Placeholder.configure({ placeholder }),
    ],
    content: initialHTML,
    onUpdate: () => onChange(),
    editorProps: {
      attributes: { class: 'mail-editor-content', spellcheck: 'true', 'aria-label': 'Message', role: 'textbox', 'aria-multiline': 'true' },
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (!files.length || !onFiles) return false;
        event.preventDefault();
        onFiles(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        if (!files.length || !onFiles) return false;
        event.preventDefault();
        onFiles(files);
        return true;
      },
    },
  });

  useImperativeHandle(
    handleRef,
    () => ({
      getHTML: () => editor?.getHTML() ?? '',
      isEmpty: () => editor?.isEmpty ?? true,
      insertHTML: (html: string) => {
        editor?.chain().focus().insertContent(html).run();
      },
      focus: () => {
        editor?.commands.focus('end');
      },
    }),
    [editor],
  );

  if (!editor) return <div className="skeleton mx-4 my-3 rounded-lg" style={{ height: minHeight }} />;
  return (
    <div className="flex min-h-0 flex-col">
      <Toolbar editor={editor} extra={toolbarExtra} />
      <div className="mail-editor min-h-0 flex-1 cursor-text px-5 py-4" style={{ minHeight }} onClick={() => editor.commands.focus()}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function Toolbar({ editor, extra }: { editor: TipTap; extra?: React.ReactNode }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
      link: e.isActive('link'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();
  return (
    <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b border-line-faint px-3 py-1.5">
      <Tool icon="type-bold" label="Bold (Ctrl+B)" active={state.bold} onClick={() => chain().toggleBold().run()} />
      <Tool icon="type-italic" label="Italic (Ctrl+I)" active={state.italic} onClick={() => chain().toggleItalic().run()} />
      <Tool text="U" underline label="Underline (Ctrl+U)" active={state.underline} onClick={() => chain().toggleUnderline().run()} />
      <Tool text="S" strike label="Strikethrough" active={state.strike} onClick={() => chain().toggleStrike().run()} />
      <ColourMenu editor={editor} />
      <Sep />
      <Tool icon="list" label="Bulleted list" active={state.bullet} onClick={() => chain().toggleBulletList().run()} />
      <Tool icon="list-ordered" label="Numbered list" active={state.ordered} onClick={() => chain().toggleOrderedList().run()} />
      <Tool icon="quote" label="Quote" active={state.quote} onClick={() => chain().toggleBlockquote().run()} />
      <LinkMenu editor={editor} active={state.link} />
      <Sep />
      <EmojiMenu editor={editor} />
      <Tool text="Tx" label="Clear formatting" onClick={() => chain().unsetAllMarks().clearNodes().run()} />
      <Sep />
      <Tool icon="rotate-ccw" label="Undo (Ctrl+Z)" disabled={!state.canUndo} onClick={() => chain().undo().run()} />
      {extra ? (
        <>
          <span className="flex-1" />
          {extra}
        </>
      ) : null}
    </div>
  );
}

const Sep = () => <span aria-hidden className="mx-1 h-4 w-px bg-line" />;

function Tool({
  icon,
  text,
  label,
  active,
  disabled,
  onClick,
  underline,
  strike,
}: {
  icon?: IconName;
  text?: string;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  underline?: boolean;
  strike?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`grid size-7 place-items-center rounded-md text-[12.5px] font-semibold transition-colors disabled:opacity-35 ${
        active ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-canvas hover:text-ink-900'
      }`}
    >
      {icon ? <Icon name={icon} size={14} /> : <span className={`${underline ? 'underline' : ''} ${strike ? 'line-through' : ''}`}>{text}</span>}
    </button>
  );
}

function ColourMenu({ editor }: { editor: TipTap }) {
  return (
    <Popover
      width={176}
      trigger={() => (
        <span title="Text colour" className="grid size-7 place-items-center rounded-md text-ink-500 hover:bg-canvas hover:text-ink-900">
          <span className="text-[12.5px] font-bold leading-none" style={{ borderBottom: '2.5px solid #b02a30' }}>A</span>
          <span className="sr-only">Text colour</span>
        </span>
      )}
    >
      {(close) => (
        <div className="flex flex-wrap gap-1.5 p-1">
          {COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Colour ${c}`}
              onClick={() => {
                editor.chain().focus().setColor(c).run();
                close();
              }}
              className="size-6 rounded-full ring-1 ring-black/10 transition-transform hover:scale-110"
              style={{ background: c }}
            />
          ))}
          <button
            type="button"
            onClick={() => {
              editor.chain().focus().unsetColor().run();
              close();
            }}
            className="mt-1 w-full rounded-md px-2 py-1 text-left text-[12px] text-ink-500 hover:bg-canvas"
          >
            Default colour
          </button>
        </div>
      )}
    </Popover>
  );
}

function LinkMenu({ editor, active }: { editor: TipTap; active: boolean }) {
  const [url, setUrl] = useState('');
  const apply = (close: () => void) => {
    const v = url.trim();
    if (!v) editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else {
      const href = /^(https?:|mailto:|tel:)/i.test(v) ? v : `https://${v}`;
      if (editor.state.selection.empty) editor.chain().focus().insertContent(`<a href="${href.replace(/"/g, '%22')}">${v.replace(/</g, '&lt;')}</a> `).run();
      else editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
    setUrl('');
    close();
  };
  return (
    <Popover
      width={280}
      trigger={() => (
        <span title="Link" className={`grid size-7 place-items-center rounded-md ${active ? 'bg-ink-900 text-white' : 'text-ink-500 hover:bg-canvas hover:text-ink-900'}`}>
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
            placeholder={active ? 'Leave empty to remove the link' : 'https://…'}
            aria-label="Link address"
            className="min-w-0 flex-1 rounded-md border border-line px-2 py-1 text-[12.5px] outline-none focus:border-brand-600"
          />
          <button type="submit" className="rounded-md bg-ink-900 px-2.5 text-[12px] font-semibold text-white">
            {url.trim() || !active ? 'Add' : 'Remove'}
          </button>
        </form>
      )}
    </Popover>
  );
}

function EmojiMenu({ editor }: { editor: TipTap }) {
  return (
    <Popover
      width={340}
      trigger={() => (
        <span title="Emoji" className="grid size-7 place-items-center rounded-md text-[14px] text-ink-500 hover:bg-canvas">
          <span aria-hidden>☺</span>
          <span className="sr-only">Emoji</span>
        </span>
      )}
    >
      {(close) => (
        <EmojiPicker
          width={320}
          height={360}
          lazyLoadEmojis
          previewConfig={{ showPreview: false }}
          skinTonesDisabled
          onEmojiClick={(d) => {
            editor.chain().focus().insertContent(d.emoji).run();
            close();
          }}
        />
      )}
    </Popover>
  );
}
