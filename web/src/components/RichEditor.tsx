import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import TextAlign from "@tiptap/extension-text-align";
import { useEffect, forwardRef, useImperativeHandle } from "react";

interface RichEditorProps {
  value: string;
  onChange: (html: string) => void;
  minHeight?: string;
}

export interface RichEditorHandle {
  insertText: (text: string) => void;
  setContent: (html: string) => void;
}

function Btn({ active, onClick, title, children }: {
  active?: boolean; onClick: () => void; title: string; children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      className={`px-2 py-1 rounded text-sm font-medium transition-colors ${
        active ? "bg-brand-600 text-white" : "hover:bg-gray-200 text-gray-700"
      }`}
    >
      {children}
    </button>
  );
}

const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor(
  { value, onChange, minHeight = "280px" },
  ref,
) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
    ],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
  });

  useImperativeHandle(ref, () => ({
    insertText: (text: string) => {
      editor?.chain().focus().insertContent(text).run();
    },
    setContent: (html: string) => {
      editor?.commands.setContent(html, { emitUpdate: false });
    },
  }));

  // Sync external value changes (e.g. template select)
  useEffect(() => {
    if (editor && value !== editor.getHTML()) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!editor) return null;

  return (
    <div className="border border-gray-300 rounded-lg overflow-hidden">
      {/* Toolbar */}
      <div className="flex flex-wrap gap-0.5 items-center px-2 py-1.5 bg-gray-50 border-b border-gray-200">
        <Btn active={editor.isActive("bold")}      onClick={() => editor.chain().focus().toggleBold().run()}      title="Negrito (Ctrl+B)"><strong>B</strong></Btn>
        <Btn active={editor.isActive("italic")}    onClick={() => editor.chain().focus().toggleItalic().run()}    title="Itálico (Ctrl+I)"><em>I</em></Btn>
        <Btn active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()} title="Sublinhado (Ctrl+U)"><u>U</u></Btn>
        <span className="w-px h-4 bg-gray-300 mx-1" />
        <Btn active={editor.isActive("heading", { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} title="Título 1">H1</Btn>
        <Btn active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="Título 2">H2</Btn>
        <Btn active={editor.isActive("heading", { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="Título 3">H3</Btn>
        <span className="w-px h-4 bg-gray-300 mx-1" />
        <Btn active={editor.isActive("bulletList")}  onClick={() => editor.chain().focus().toggleBulletList().run()}  title="Lista com marcadores">• Lista</Btn>
        <Btn active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="Lista numerada">1. Lista</Btn>
        <span className="w-px h-4 bg-gray-300 mx-1" />
        <Btn active={editor.isActive({ textAlign: "left" })}    onClick={() => editor.chain().focus().setTextAlign("left").run()}    title="Alinhar à esquerda">⬅</Btn>
        <Btn active={editor.isActive({ textAlign: "center" })}  onClick={() => editor.chain().focus().setTextAlign("center").run()}  title="Centralizar">⬛</Btn>
        <Btn active={editor.isActive({ textAlign: "justify" })} onClick={() => editor.chain().focus().setTextAlign("justify").run()} title="Justificar">≡</Btn>
        <span className="w-px h-4 bg-gray-300 mx-1" />
        <Btn active={false} onClick={() => editor.chain().focus().undo().run()} title="Desfazer">↩</Btn>
        <Btn active={false} onClick={() => editor.chain().focus().redo().run()} title="Refazer">↪</Btn>
      </div>

      {/* Editor area */}
      <EditorContent
        editor={editor}
        className="prose prose-sm max-w-none px-4 py-3 focus-within:outline-none"
        style={{ minHeight }}
      />

      <style>{`
        .ProseMirror { outline: none; min-height: ${minHeight}; }
        .ProseMirror h1 { font-size: 1.5rem; font-weight: 700; margin: 1rem 0 .5rem; color: #004a5c; }
        .ProseMirror h2 { font-size: 1.2rem; font-weight: 700; margin: .9rem 0 .4rem; color: #004a5c; }
        .ProseMirror h3 { font-size: 1rem;   font-weight: 700; margin: .8rem 0 .3rem; color: #004a5c; }
        .ProseMirror p  { margin: .4rem 0; line-height: 1.6; }
        .ProseMirror ul { list-style: disc;    padding-left: 1.4rem; margin: .4rem 0; }
        .ProseMirror ol { list-style: decimal; padding-left: 1.4rem; margin: .4rem 0; }
        .ProseMirror li { margin: .2rem 0; }
        .ProseMirror strong { font-weight: 700; }
        .ProseMirror em     { font-style: italic; }
        .ProseMirror u      { text-decoration: underline; }
      `}</style>
    </div>
  );
});

export default RichEditor;
