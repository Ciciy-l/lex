// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef, forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileBodyView, type FileBodyHandle } from '../FileBodyView';
import type { FileContent } from '../hooks/useFileContent';

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), writeFile: vi.fn() }));
vi.mock('@/lib/fileBrowserTransport', () => ({ fileBrowserApiFor: () => mocks }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useAppShortcut', () => ({ useAppShortcut: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/markdown/MermaidLightboxHost', () => ({ MermaidLightboxHost: () => null }));
vi.mock('@/components/markdown/MermaidSourceEditor', () => ({
  MermaidSourceEditorHost: () => null,
}));
vi.mock('@/components/markdown/MarkdownImageLightboxHost', () => ({
  MarkdownImageLightboxHost: () => null,
}));
vi.mock('@/components/chat/SelectionQuoteButton', () => ({ SelectionQuoteButton: () => null }));
vi.mock('../ImagePreview', () => ({ ImagePreview: () => null }));
vi.mock('../PdfPreview', () => ({ PdfPreview: () => null }));
vi.mock('../DrawioPreview', () => ({ DrawioPreview: () => null }));
vi.mock('../OpenInSystemActions', () => ({ OpenInSystemActions: () => null }));
vi.mock('@/components/markdown/PlaintextEditor', () => ({
  PlaintextEditor: forwardRef(function Editor(
    {
      initialValue,
      onChange,
      readOnly,
    }: { initialValue: string; onChange?: (value: string) => void; readOnly: boolean },
    ref,
  ) {
    const textarea = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => ({
      getValue: () => textarea.current?.value ?? '',
      setValue: (value: string) => {
        if (textarea.current) textarea.current.value = value;
      },
      search: { clear: vi.fn() },
    }));
    return (
      <textarea
        aria-label="editor"
        ref={textarea}
        defaultValue={initialValue}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
      />
    );
  }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('FileBodyView saves with concurrent typing', () => {
  it('keeps edits typed during a successful save and refuses to report them as saved', async () => {
    vi.useFakeTimers();
    let diskContent = 'A';
    let finishWrite!: () => void;
    mocks.readFile.mockImplementation(async () => ({
      ok: true,
      data: { content: diskContent, truncated: false, size: 1, mtimeMs: 1 },
    }));
    mocks.writeFile
      .mockImplementationOnce(
        ({ content }: { content: string }) =>
          new Promise((resolve) => {
            finishWrite = () => {
              diskContent = content;
              resolve({ ok: true, size: 1, mtimeMs: 2 });
            };
          }),
      )
      .mockImplementation(async ({ content }: { content: string }) => {
        diskContent = content;
        return { ok: true, size: 1, mtimeMs: 3 };
      });
    const handle = createRef<FileBodyHandle>();
    function Harness() {
      const [content, setContent] = useState<FileContent>({
        kind: 'text',
        relPath: 'a.ts',
        content: 'A',
        size: 1,
        mtimeMs: 1,
        truncated: false,
      });
      return (
        <FileBodyView
          ref={handle}
          workdir="/workspace"
          relPath="a.ts"
          content={content}
          onSaved={(data) => setContent({ ...data, kind: 'text', relPath: 'a.ts' })}
        />
      );
    }
    render(<Harness />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'B' } });
    expect(handle.current?.isDirty()).toBe(true);
    let saving!: Promise<boolean>;
    await act(async () => {
      saving = handle.current!.save();
      await Promise.resolve();
    });
    expect(mocks.writeFile).toHaveBeenCalledWith(expect.objectContaining({ content: 'B' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'C' } });
    await act(async () => {
      finishWrite();
      expect(await saving).toBe(false);
    });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('C');
    expect(handle.current?.isDirty()).toBe(true);
    expect(diskContent).toBe('B');
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(mocks.writeFile).toHaveBeenCalledTimes(1); // Code files never gain Markdown autosave.
    await act(async () => {
      expect(await handle.current!.save()).toBe(true);
      expect(handle.current!.isDirty()).toBe(false); // Even before React commits dirty=false.
    });
    expect(diskContent).toBe('C');
  });
});
