// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  parseProviderModelIds,
  ProviderModelIdsField,
} from '../ProviderModelIdsField';

afterEach(cleanup);

function Harness({ initial }: { initial: string[] }) {
  const [ids, setIds] = useState(initial);
  const [draft, setDraft] = useState('');
  return (
    <>
      <ProviderModelIdsField
        ids={ids}
        draft={draft}
        onDraftChange={setDraft}
        onChange={setIds}
        label="Model IDs"
        addLabel="Add Model ID"
        placeholder="e.g. model-id"
        removeLabel={(index) => `Remove Model ID ${index}`}
        rowLabel={(index) => `Model ID ${index}`}
        emptyLabel="No model IDs yet"
      />
      <output data-testid="ids">{ids.join('|')}</output>
    </>
  );
}

describe('ProviderModelIdsField', () => {
  it('normalizes pasted multiline IDs with trim, blank removal, and exact de-duplication', () => {
    render(<Harness initial={[]} />);
    const input = screen.getByLabelText('Add Model ID');
    fireEvent.paste(input, {
      clipboardData: { getData: () => ' alpha\r\n beta\nalpha\n\n gamma ' },
    });
    expect(screen.getByTestId('ids').textContent).toBe('alpha|beta|gamma');
  });

  it('keeps commas inside a single model ID instead of treating them as separators', () => {
    expect(parseProviderModelIds('provider:model,variant\nnext-model')).toEqual([
      'provider:model,variant',
      'next-model',
    ]);
  });

  it('edits and removes individual rows without merging protocol drafts', () => {
    render(<Harness initial={['alpha', 'beta']} />);
    fireEvent.change(screen.getByLabelText('Model ID 2'), { target: { value: 'beta-2' } });
    expect(screen.getByTestId('ids').textContent).toBe('alpha|beta-2');
    fireEvent.change(screen.getByLabelText('Model ID 1'), { target: { value: '' } });
    expect((screen.getByLabelText('Model ID 1') as HTMLInputElement).value).toBe('');
    fireEvent.change(screen.getByLabelText('Model ID 1'), { target: { value: 'alpha-2' } });
    expect(screen.getByTestId('ids').textContent).toBe('alpha-2|beta-2');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Model ID 1' }));
    expect(screen.getByTestId('ids').textContent).toBe('beta-2');
  });

  it('leaves a single-line comma paste to ordinary text input', () => {
    render(<Harness initial={[]} />);
    const input = screen.getByLabelText('Add Model ID');
    const notPrevented = fireEvent.paste(input, {
      clipboardData: { getData: () => 'model,variant' },
    });
    expect(notPrevented).toBe(true);
  });

  it('merges a multiline paste with the existing draft and cursor position', () => {
    render(<Harness initial={[]} />);
    const input = screen.getByLabelText('Add Model ID') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'vendor/' } });
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.paste(input, {
      clipboardData: { getData: () => 'model,variant\nnext' },
    });
    expect(screen.getByTestId('ids').textContent).toBe('vendor/model,variant|next');
    expect(input.value).toBe('');
  });

  it('replaces the selected draft text when pasting multiple lines', () => {
    render(<Harness initial={[]} />);
    const input = screen.getByLabelText('Add Model ID') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'vendor/' } });
    input.setSelectionRange(0, input.value.length);
    fireEvent.paste(input, { clipboardData: { getData: () => 'x\ny' } });
    expect(screen.getByTestId('ids').textContent).toBe('x|y');
  });

  it('returns focus to the add field after removing the last row', async () => {
    render(<Harness initial={['alpha']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Model ID 1' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Add Model ID')),
    );
  });

  it('adds one ID with Enter and ignores blank or duplicate values', () => {
    render(<Harness initial={['alpha']} />);
    const input = screen.getByLabelText('Add Model ID');
    fireEvent.change(input, { target: { value: 'alpha' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('ids').textContent).toBe('alpha');
    fireEvent.change(input, { target: { value: ' beta ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('ids').textContent).toBe('alpha|beta');
  });

  it('trims and de-duplicates exact IDs while keeping case, commas and first-seen order', () => {
    expect(parseProviderModelIds(' a, b\nA\n a, b \n')).toEqual(['a, b', 'A']);
  });
});
