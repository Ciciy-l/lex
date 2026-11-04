// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CustomProviderConfig } from '@cindy/model-providers';

const providerMocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/customProviders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/customProviders')>()),
  createCustomProvider: providerMocks.create,
  updateCustomProvider: providerMocks.update,
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ serviceRealm: 'global' }) }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, values?: Record<string, unknown>) => {
      const protocolNames: Record<string, string> = {
        'models.channels.protocolNames.anthropicMessages': 'Anthropic Messages',
        'models.channels.protocolNames.openaiResponses': 'OpenAI Responses',
        'models.channels.protocolNames.openaiChat': 'OpenAI Chat Completions',
        'models.channels.protocolNames.googleGemini': 'Google Gemini',
      };
      if (protocolNames[key]) return protocolNames[key];
      if (key === 'models.channels.protocolTabLabel') return `${values?.protocol} (${values?.count})`;
      if (key === 'models.channels.channelOptionLabel') return `${values?.name} / ${values?.protocol} / ${values?.models}`;
      if (key === 'models.channels.channelSummary') return `${values?.protocols} protocols / ${values?.models} models`;
      if (key === 'models.channels.channelOptionLabelWithInstance')
        return `${values?.name} / ${values?.protocol} / ${values?.models} / ${values?.position}/${values?.total}`;
      if (key === 'models.channels.channelInstanceSuffix')
        return `${values?.position}/${values?.total}`;
      if (key === 'models.channels.testNeedsCredentials') return 'TEST_NEEDS_CREDENTIALS';
      if (key === 'models.channels.modelIdRowLabel') return `Model ID ${values?.index}`;
      if (key === 'models.channels.addModelId') return 'Add Model ID';
      if (key === 'models.channels.removeModelIdRowLabel') return `Remove Model ID ${values?.index}`;
      if (key === 'models.channels.modelIds') return 'Model IDs';
      if (key === 'models.channels.noModels') return 'No model IDs yet';
      if (key === 'models.channels.keepKey') return 'Leave unchanged to keep the saved key';
      return key;
    },
  }),
}));

import { ProviderChannelsDialog } from '../ProviderChannelsDialog';

function initialConfig(): CustomProviderConfig {
  return {
    id: 'provider-one',
    name: 'Provider One',
    auth: { method: 'apiKey' },
    runtimes: {},
    channels: {
      version: 1,
      channels: [
        {
          id: 'channel-a',
          name: 'Primary East',
          protocols: {
            'anthropic-messages': {
              baseUrl: 'https://anthropic.example.test',
              wireProtocol: 'anthropic-messages',
              models: [{
                id: 'claude-a',
                name: 'Claude East',
                contextWindow: 200_000,
                defaultEnabled: false,
              }],
            },
            'openai-responses': {
              baseUrl: 'https://responses.example.test',
              wireProtocol: 'openai-responses',
              models: [{ id: 'response-a', name: 'response-a' }],
            },
          },
        },
        {
          id: 'channel-b',
          name: 'Backup West',
          protocols: {
            'anthropic-messages': {
              baseUrl: 'https://anthropic-backup.example.test',
              wireProtocol: 'anthropic-messages',
              models: [{
                id: 'claude-a',
                name: 'Claude West',
                contextWindow: 128_000,
                defaultEnabled: true,
              }],
            },
            'openai-chat': {
              baseUrl: 'https://chat.example.test',
              wireProtocol: 'openai-chat',
              models: [{ id: 'chat-b', name: 'chat-b' }],
            },
          },
        },
      ],
    },
  };
}

beforeEach(() => {
  providerMocks.create.mockReset().mockResolvedValue({ ok: true });
  providerMocks.update.mockReset().mockResolvedValue({ ok: true });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        listProviderPresets: vi.fn(async () => ({ presets: [] })),
        fetchProviderModels: vi.fn(async () => ({ ok: true, models: [] })),
        testProviderConnection: vi.fn(async () => ({ ok: true })),
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

import { cleanup } from '@testing-library/react';

describe('ProviderChannelsDialog protocol and channel navigation', () => {
  it('shows protocol tabs and keeps each protocol channel and model draft independent', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<ProviderChannelsDialog initial={initialConfig()} onSaved={onSaved} onClose={vi.fn()} />);

    const anthropicTab = screen.getByRole('tab', { name: 'Anthropic Messages (2)' });
    const responsesTab = screen.getByRole('tab', { name: 'OpenAI Responses (1)' });
    expect(anthropicTab.getAttribute('aria-controls')).toBeTruthy();
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(anthropicTab.id);
    expect(screen.getByRole('radio', { name: 'Primary East / Anthropic Messages / 1' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Backup West / Anthropic Messages / 1' })
      .getAttribute('aria-checked')).toBe('false');

    const anthropicInput = screen.getByLabelText('Add Model ID');
    await user.type(anthropicInput, 'claude-new');
    await user.click(screen.getByRole('button', { name: 'Add Model ID' }));

    await user.click(responsesTab);
    expect(screen.getByRole('radio', { name: 'Primary East / OpenAI Responses / 1' })
      .getAttribute('aria-checked')).toBe('true');
    const responsesInput = screen.getByLabelText('Add Model ID');
    await user.type(responsesInput, 'response-new');
    await user.click(screen.getByRole('button', { name: 'Add Model ID' }));

    await user.click(anthropicTab);
    expect((screen.getByLabelText('Model ID 1') as HTMLInputElement).value).toBe('claude-a');
    expect((screen.getByLabelText('Model ID 2') as HTMLInputElement).value).toBe('claude-new');
    expect(screen.queryByDisplayValue('response-new')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(providerMocks.update).toHaveBeenCalledOnce());
    const saved = providerMocks.update.mock.calls[0][0] as CustomProviderConfig;
    expect(saved.channels!.channels[0].protocols['anthropic-messages']!.models.map((m) => m.id))
      .toEqual(['claude-a', 'claude-new']);
    expect(saved.channels!.channels[0].protocols['anthropic-messages']!.models[0]).toMatchObject({
      id: 'claude-a',
      name: 'Claude East',
      contextWindow: 200_000,
      defaultEnabled: false,
    });
    expect(saved.channels!.channels[0].protocols['anthropic-messages']!.models[1]).toMatchObject({
      id: 'claude-new',
      name: 'claude-new',
      defaultEnabled: true,
    });
    expect(saved.channels!.channels[0].protocols['openai-responses']!.models.map((m) => m.id))
      .toEqual(['response-a', 'response-new']);
    expect(saved.channels!.channels[1].protocols['openai-chat']!.models.map((m) => m.id))
      .toEqual(['chat-b']);
    expect(saved.channels!.channels[1].protocols['anthropic-messages']!.models[0]).toMatchObject({
      id: 'claude-a',
      name: 'Claude West',
      contextWindow: 128_000,
      defaultEnabled: true,
    });
  });

  it('blocks save for an uncommitted model ID and preserves it across protocol switches', async () => {
    const user = userEvent.setup();
    render(<ProviderChannelsDialog initial={initialConfig()} onSaved={vi.fn()} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText('Add Model ID'), 'not-committed');
    const save = screen.getByRole('button', { name: 'settings.providers.custom.save' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('models.channels.pendingModelId')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'OpenAI Responses (1)' }));
    await user.click(screen.getByRole('tab', { name: 'Anthropic Messages (2)' }));
    expect((screen.getByLabelText('Add Model ID') as HTMLInputElement).value).toBe('not-committed');
    await user.clear(screen.getByLabelText('Add Model ID'));
    expect((save as HTMLButtonElement).disabled).toBe(false);
  });

  it('does not test or discover against a stale model list while a new ID is pending', async () => {
    const user = userEvent.setup();
    render(<ProviderChannelsDialog initial={initialConfig()} onSaved={vi.fn()} onClose={vi.fn()} />);
    await user.type(screen.getByLabelText('Add Model ID'), 'pending-id');

    await user.click(screen.getByRole('button', { name: 'models.channels.discover' }));
    expect(window.electronAPI.maker.fetchProviderModels).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('models.channels.pendingModelId');

    await user.clear(screen.getByLabelText('Add Model ID'));
    await user.click(screen.getByRole('button', { name: 'models.channels.test' }));
    await waitFor(() => expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledOnce());
    expect(screen.getByText('models.channels.connected')).toBeTruthy();

    await user.type(screen.getByLabelText('Model ID 1'), 'claude-edited');
    expect(screen.queryByText('models.channels.connected')).toBeNull();
  });

  it('keeps stored credentials for an edited model on the same endpoint', async () => {
    const user = userEvent.setup();
    render(<ProviderChannelsDialog initial={initialConfig()} onSaved={vi.fn()} onClose={vi.fn()} />);
    const testButton = () => screen.getByRole('button', { name: 'models.channels.test' });

    await user.click(testButton());
    await waitFor(() => expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledOnce());
    expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledWith({
      kind: 'saved',
      providerId: 'channel-a--anthropic-messages',
      agent: 'pi',
      modelId: 'claude-a',
      endpoint: {
        baseUrl: 'https://anthropic.example.test',
        wireProtocol: 'anthropic-messages',
        modelsUrl: null,
      },
    });

    fireEvent.change(screen.getByLabelText('Model ID 1'), { target: { value: 'claude-new' } });
    await user.click(testButton());
    await waitFor(() =>
      expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledTimes(2),
    );
    expect(window.electronAPI.maker.testProviderConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'saved',
        providerId: 'channel-a--anthropic-messages',
        modelId: 'claude-new',
        endpoint: expect.objectContaining({ baseUrl: 'https://anthropic.example.test' }),
      }),
    );
  });

  it('probes the first chat model instead of a leading media model', async () => {
    const config = initialConfig();
    config.channels!.channels[0].protocols['anthropic-messages']!.models = [
      { id: 'image-a', name: 'image-a', mode: 'image_generation' },
      { id: 'chat-a', name: 'chat-a' },
    ];
    const user = userEvent.setup();
    render(<ProviderChannelsDialog initial={config} onSaved={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Model ID 2'), { target: { value: 'chat-new' } });
    await user.click(screen.getByRole('button', { name: 'models.channels.test' }));
    await waitFor(() =>
      expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledOnce(),
    );
    expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'saved',
        modelId: 'chat-new',
      }),
    );
  });

  it('blocks keyless tests after an endpoint change and probes with the new key', async () => {
    const user = userEvent.setup();
    render(<ProviderChannelsDialog initial={initialConfig()} onSaved={vi.fn()} onClose={vi.fn()} />);
    const testButton = () => screen.getByRole('button', { name: 'models.channels.test' });

    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://changed.example.test' },
    });
    await user.click(testButton());
    expect(window.electronAPI.maker.testProviderConnection).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('TEST_NEEDS_CREDENTIALS');

    await user.type(
      screen.getByPlaceholderText('Leave unchanged to keep the saved key'),
      'new-key',
    );
    await user.click(testButton());
    await waitFor(() =>
      expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledOnce(),
    );
    expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'adhoc',
        spec: expect.objectContaining({
          baseUrl: 'https://changed.example.test',
          apiKey: 'new-key',
        }),
      }),
    );
  });

  it('allows an edited-model probe when draft headers authenticate the route', async () => {
    const user = userEvent.setup();
    render(<ProviderChannelsDialog initial={initialConfig()} onSaved={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('models.channels.advanced'));
    fireEvent.change(screen.getByLabelText('models.channels.headers'), {
      target: { value: '{"x-api-key":"header-key"}' },
    });
    fireEvent.change(screen.getByLabelText('Model ID 1'), { target: { value: 'claude-new' } });

    await user.click(screen.getByRole('button', { name: 'models.channels.test' }));
    await waitFor(() =>
      expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledOnce(),
    );
    expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'adhoc',
        spec: expect.objectContaining({
          modelId: 'claude-new',
          headers: { 'x-api-key': 'header-key' },
        }),
      }),
    );
  });

  it('tests the probe model on its model-level route instead of the channel default', async () => {
    const config = initialConfig();
    config.channels!.channels[0].protocols['anthropic-messages']!.models = [
      { id: 'chat-a', name: 'chat-a' },
      {
        id: 'chat-b',
        name: 'chat-b',
        route: {
          baseUrl: 'https://alternate.example.test/v1',
          wireProtocol: 'anthropic-messages',
        },
      },
    ];
    const user = userEvent.setup();
    render(<ProviderChannelsDialog initial={config} onSaved={vi.fn()} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Remove Model ID 1' }));
    await user.click(screen.getByRole('button', { name: 'models.channels.test' }));
    await waitFor(() =>
      expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledOnce(),
    );
    expect(window.electronAPI.maker.testProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'saved',
        modelId: 'chat-b',
        endpoint: expect.objectContaining({
          baseUrl: 'https://alternate.example.test/v1',
        }),
      }),
    );
  });

  it('warns about dropped credentials only for the fields Main treats as endpoint changes', () => {
    render(<ProviderChannelsDialog initial={initialConfig()} onSaved={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('models.channels.requestPath'), {
      target: { value: '/custom/messages' },
    });
    expect(screen.queryByText('models.channels.endpointChanged')).toBeNull();

    fireEvent.change(screen.getByLabelText('models.channels.modelsUrl'), {
      target: { value: 'https://anthropic.example.test/models' },
    });
    expect(screen.getByText('models.channels.endpointChanged')).toBeTruthy();
  });

  it('keeps an edited Model ID row mounted while it is cleared and retyped', async () => {
    const user = userEvent.setup();
    render(<ProviderChannelsDialog initial={initialConfig()} onSaved={vi.fn()} onClose={vi.fn()} />);
    await user.clear(screen.getByLabelText('Model ID 1'));
    await user.type(screen.getByLabelText('Model ID 1'), 'claude-replaced');
    expect((screen.getByLabelText('Model ID 1') as HTMLInputElement).value).toBe('claude-replaced');

    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(providerMocks.update).toHaveBeenCalledOnce());
    const saved = providerMocks.update.mock.calls[0][0] as CustomProviderConfig;
    expect(saved.channels!.channels[0].protocols['anthropic-messages']!.models).toMatchObject([
      { id: 'claude-replaced', name: 'claude-replaced', defaultEnabled: true },
    ]);
  });

  it('shows no model row after deleting the last one and can add one again', async () => {
    const user = userEvent.setup();
    render(<ProviderChannelsDialog initial={initialConfig()} onSaved={vi.fn()} onClose={vi.fn()} />);
    expect((screen.getByLabelText('Model ID 1') as HTMLInputElement).value).toBe('claude-a');

    await user.click(screen.getByRole('button', { name: 'Remove Model ID 1' }));
    expect(screen.queryByLabelText('Model ID 1')).toBeNull();
    expect(screen.getByText('No model IDs yet')).toBeTruthy();

    await user.type(screen.getByLabelText('Add Model ID'), 'claude-new');
    await user.click(screen.getByRole('button', { name: 'Add Model ID' }));
    expect((screen.getByLabelText('Model ID 1') as HTMLInputElement).value).toBe('claude-new');
  });

  it('switching to an empty protocol does not create or modify any route', async () => {
    const user = userEvent.setup();
    render(<ProviderChannelsDialog initial={initialConfig()} onSaved={vi.fn()} onClose={vi.fn()} />);
    await user.click(screen.getByRole('tab', { name: 'Google Gemini (0)' }));
    expect(screen.queryAllByRole('radio')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(providerMocks.update).toHaveBeenCalledOnce());
    const saved = providerMocks.update.mock.calls[0][0] as CustomProviderConfig;
    expect(Object.keys(saved.channels!.channels[0].protocols)).toEqual([
      'anthropic-messages',
      'openai-responses',
    ]);
    expect(Object.keys(saved.channels!.channels[1].protocols)).toEqual([
      'anthropic-messages',
      'openai-chat',
    ]);
  });

  it('distinguishes channels and supports keyboard selection plus attaching another protocol', async () => {
    const user = userEvent.setup();
    render(<ProviderChannelsDialog initial={initialConfig()} onSaved={vi.fn()} onClose={vi.fn()} />);

    const primary = screen.getByRole('radio', { name: 'Primary East / Anthropic Messages / 1' });
    const backup = screen.getByRole('radio', { name: 'Backup West / Anthropic Messages / 1' });
    primary.focus();
    fireEvent.keyDown(primary, { key: 'ArrowRight' });
    expect(backup.getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(backup));

    await user.click(screen.getByRole('tab', { name: 'Google Gemini (0)' }));
    expect(screen.getByRole('button', { name: 'Primary East' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Backup West' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Backup West' }));
    expect(screen.getByRole('radio', { name: 'Backup West / Google Gemini / 0' })
      .getAttribute('aria-checked')).toBe('true');

    const keyInput = screen.getByPlaceholderText('Leave unchanged to keep the saved key');
    expect((keyInput as HTMLInputElement).value).toBe('');
    await user.type(keyInput, 'temporary-secret');
    await user.click(screen.getByRole('tab', { name: 'Anthropic Messages (2)' }));
    expect((screen.getByPlaceholderText('Leave unchanged to keep the saved key') as HTMLInputElement).value)
      .toBe('');
    await user.click(screen.getByRole('tab', { name: 'Google Gemini (1)' }));
    expect(screen.getByDisplayValue('temporary-secret')).toBeTruthy();
    expect(within(document.body).getByText('3 protocols / 0 models')).toBeTruthy();
  });

  it('gives same-named channels distinct instance labels without merging identities', async () => {
    const config = initialConfig();
    config.channels!.channels[1].name = 'Primary East';
    const user = userEvent.setup();
    render(<ProviderChannelsDialog initial={config} onSaved={vi.fn()} onClose={vi.fn()} />);

    const cards = screen.getAllByRole('radio', { name: /Primary East/ });
    expect(cards).toHaveLength(2);
    expect(cards[0].getAttribute('aria-label')).not.toBe(cards[1].getAttribute('aria-label'));
    expect(screen.getByText('1/2')).toBeTruthy();
    expect(screen.getByText('2/2')).toBeTruthy();

    await user.click(cards[1]);
    expect(
      (screen.getByDisplayValue('https://anthropic-backup.example.test') as HTMLInputElement).value,
    ).toBe('https://anthropic-backup.example.test');

    await user.click(screen.getByRole('tab', { name: 'Google Gemini (0)' }));
    const attach = screen.getAllByRole('button', { name: /Primary East/ });
    expect(attach).toHaveLength(2);
    expect(attach[0].getAttribute('aria-label')).not.toBe(attach[1].getAttribute('aria-label'));
  });

  it('keeps dirty-cancel confirmation and restores the input when editing continues', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ProviderChannelsDialog initial={initialConfig()} onSaved={vi.fn()} onClose={onClose} />);
    const name = screen.getByDisplayValue('Primary East');
    await user.clear(name);
    await user.type(name, 'Renamed East');
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.cancel' }));
    expect(screen.getByRole('alertdialog', { name: 'models.channels.discardTitle' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'models.channels.keepEditing' }));
    expect(screen.getByDisplayValue('Renamed East')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.cancel' }));
    await user.click(screen.getByRole('button', { name: 'models.channels.discard' }));
    expect(onClose).toHaveBeenCalledOnce();
    cleanup();
    render(<ProviderChannelsDialog initial={initialConfig()} onSaved={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue('Primary East')).toBeTruthy();
  });

  it('keeps key edits per route and submits an explicit empty value after clearing', async () => {
    const user = userEvent.setup();
    render(<ProviderChannelsDialog initial={initialConfig()} onSaved={vi.fn()} onClose={vi.fn()} />);
    const key = screen.getByPlaceholderText('Leave unchanged to keep the saved key');
    await user.type(key, 'temporary-secret');
    await user.click(screen.getByRole('tab', { name: 'OpenAI Responses (1)' }));
    await user.click(screen.getByRole('tab', { name: 'Anthropic Messages (2)' }));
    expect(screen.getByDisplayValue('temporary-secret')).toBeTruthy();

    fireEvent.change(screen.getByDisplayValue('https://anthropic.example.test'), {
      target: { value: 'https://anthropic-changed.example.test' },
    });
    expect(screen.getByText('models.channels.endpointChanged')).toBeTruthy();
    await user.clear(screen.getByDisplayValue('temporary-secret'));
    await user.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(providerMocks.update).toHaveBeenCalledOnce());
    expect(providerMocks.update.mock.calls[0][2]).toMatchObject({
      channelKeys: { 'channel-a': { 'anthropic-messages': '' } },
    });
  });
});
