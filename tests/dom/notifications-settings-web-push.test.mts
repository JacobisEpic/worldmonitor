import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelsData } from '@/services/notification-channels';

import { initTestI18n, tt } from './helpers/i18n.mts';

const pushState = vi.hoisted(() => ({
  supported: true,
  permission: 'default' as 'default' | 'granted' | 'denied' | 'unsupported',
  subscribeToPush: vi.fn<() => Promise<unknown>>(),
}));

const channelMocks = vi.hoisted(() => ({
  getChannelsData: vi.fn(),
  saveAlertRules: vi.fn(),
}));

vi.mock('@/services/push-notifications', () => ({
  isWebPushSupported: () => pushState.supported,
  getPushPermission: () => pushState.permission,
  subscribeToPush: pushState.subscribeToPush,
  unsubscribeFromPush: vi.fn(),
}));

vi.mock('@/services/notification-channels', () => ({
  getChannelsData: channelMocks.getChannelsData,
  saveAlertRules: channelMocks.saveAlertRules,
  createPairingToken: vi.fn(),
  setEmailChannel: vi.fn(),
  setWebhookChannel: vi.fn(),
  startSlackOAuth: vi.fn(),
  startDiscordOAuth: vi.fn(),
  deleteChannel: vi.fn(),
  setQuietHours: vi.fn(),
  setDigestSettings: vi.fn(),
  setNotificationConfig: vi.fn(),
  IncompatibleDeliveryError: class IncompatibleDeliveryError extends Error {},
}));

vi.mock('@/services/clerk', () => ({
  getCurrentClerkUser: () => ({ id: 'user_push', email: 'push@worldmonitor.test' }),
}));

vi.mock('@/services/entitlements', () => ({
  hasTier: () => true,
}));

vi.mock('@/services/market-watchlist', () => ({
  getMarketWatchlistEntries: () => [],
}));

vi.mock('@/utils/country-chip-picker', () => ({
  loadFollowedCountriesSafe: () => [],
  mountCountryChipPicker: () => ({
    getValue: () => [],
    setValue: () => {},
    destroy: () => {},
  }),
}));

vi.mock('uqr', () => ({
  renderSVG: () => '<svg></svg>',
}));

import { renderNotificationsSettings } from '@/services/notifications-settings';

const EMPTY_DATA: ChannelsData = { channels: [], alertRules: [] };
const cleanups: Array<() => void> = [];

async function mount(data: ChannelsData = EMPTY_DATA): Promise<HTMLElement> {
  channelMocks.getChannelsData.mockResolvedValue(data);
  const container = document.createElement('div');
  const rendered = renderNotificationsSettings({ isSignedIn: true });
  container.innerHTML = rendered.html;
  document.body.appendChild(container);
  cleanups.push(rendered.attach(container));

  await vi.waitFor(() => {
    expect(container.querySelector<HTMLElement>('#usNotifContent')?.style.display).toBe('block');
  });
  return container;
}

function webPushRow(container: HTMLElement): HTMLElement {
  const row = container.querySelector<HTMLElement>('[data-channel-type="web_push"]');
  expect(row).not.toBeNull();
  return row!;
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
  pushState.supported = true;
  pushState.permission = 'default';
  pushState.subscribeToPush.mockReset();
  pushState.subscribeToPush.mockResolvedValue({
    endpoint: 'https://push.test/subscription',
    p256dh: 'key',
    auth: 'auth',
    userAgent: 'test',
  });
  channelMocks.getChannelsData.mockReset();
  channelMocks.saveAlertRules.mockReset();
  channelMocks.saveAlertRules.mockResolvedValue(undefined);
});

afterAll(() => {
  while (cleanups.length) cleanups.pop()?.();
  document.body.replaceChildren();
});

describe('notification Settings browser push', () => {
  it('renders denied permission as browser site-settings guidance without Enable', async () => {
    pushState.permission = 'denied';
    const container = await mount();
    const row = webPushRow(container);

    expect(row.dataset.webPushState).toBe('denied');
    expect(row.querySelector('.us-notif-ch-sub')?.textContent).toBe(
      tt('components.proActivation.steps.alerts.blockedNote'),
    );
    expect(row.querySelector('#usConnectWebPush')).toBeNull();
    expect(row.querySelector('.us-notif-ch-badge')?.textContent).toBe('Blocked');

    expect(container.querySelector('#usConnectTelegram')).not.toBeNull();
    expect(container.querySelector('#usConnectEmail')).not.toBeNull();
    expect(container.querySelector('#usConnectSlack')).not.toBeNull();
    expect(container.querySelector('#usConnectDiscord')).not.toBeNull();
    expect(container.querySelector('#usConnectWebhook')).not.toBeNull();
  });

  it('re-checks live permission before subscribing', async () => {
    const container = await mount();
    const button = container.querySelector<HTMLButtonElement>('#usConnectWebPush');
    expect(button).not.toBeNull();

    pushState.permission = 'denied';
    button!.click();

    await vi.waitFor(() => {
      expect(webPushRow(container).dataset.webPushState).toBe('denied');
    });
    expect(pushState.subscribeToPush).not.toHaveBeenCalled();
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
    expect(webPushRow(container).textContent).not.toContain('Requesting');
  });

  it('shows blocked guidance when denial is discovered through rejection', async () => {
    const container = await mount();
    pushState.subscribeToPush.mockImplementation(async () => {
      pushState.permission = 'denied';
      throw new Error('permission rejected');
    });

    container.querySelector<HTMLButtonElement>('#usConnectWebPush')!.click();

    await vi.waitFor(() => {
      expect(webPushRow(container).dataset.webPushState).toBe('denied');
    });
    const row = webPushRow(container);
    expect(pushState.subscribeToPush).toHaveBeenCalledTimes(1);
    expect(row.querySelector('#usConnectWebPush')).toBeNull();
    expect(row.querySelector('.us-notif-ch-sub')?.textContent).toBe(
      tt('components.proActivation.steps.alerts.blockedNote'),
    );
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
  });

  it('surfaces a safe retryable error when subscription fails without denial', async () => {
    const container = await mount();
    pushState.subscribeToPush.mockRejectedValue(
      new Error('secret endpoint https://internal.example/token/123 failed'),
    );

    container.querySelector<HTMLButtonElement>('#usConnectWebPush')!.click();

    await vi.waitFor(() => {
      expect(webPushRow(container).querySelector('.us-notif-error')).not.toBeNull();
    });
    const row = webPushRow(container);
    const button = row.querySelector<HTMLButtonElement>('#usConnectWebPush');
    const error = row.querySelector<HTMLElement>('.us-notif-error');
    expect(error?.textContent).toBe('Could not enable browser notifications. Try again.');
    expect(error?.getAttribute('role')).toBe('alert');
    expect(row.textContent).not.toContain('internal.example');
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toBe('Enable');
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
  });

  it('preserves the successful subscription and rule-update path', async () => {
    const container = await mount();

    container.querySelector<HTMLButtonElement>('#usConnectWebPush')!.click();

    await vi.waitFor(() => {
      expect(channelMocks.getChannelsData).toHaveBeenCalledTimes(2);
    });
    expect(pushState.subscribeToPush).toHaveBeenCalledTimes(1);
    expect(channelMocks.saveAlertRules).toHaveBeenCalledTimes(1);
    expect(channelMocks.saveAlertRules.mock.calls[0]?.[0]).toMatchObject({
      channels: ['web_push'],
    });
    const row = webPushRow(container);
    expect(row.dataset.webPushState).toBe('available');
    expect(row.querySelector('.us-notif-error')).toBeNull();
    expect(row.querySelector('.us-notif-ch-badge-blocked')).toBeNull();
  });

  it('keeps unsupported browsers non-actionable', async () => {
    pushState.supported = false;
    pushState.permission = 'unsupported';
    const container = await mount();
    const row = webPushRow(container);

    expect(row.dataset.webPushState).toBe('unsupported');
    expect(row.querySelector('#usConnectWebPush')).toBeNull();
    expect(row.textContent).toContain('Not supported');
    expect(pushState.subscribeToPush).not.toHaveBeenCalled();
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
  });

  it('becomes non-actionable if support disappears before the click', async () => {
    const container = await mount();
    pushState.supported = false;
    pushState.permission = 'unsupported';

    container.querySelector<HTMLButtonElement>('#usConnectWebPush')!.click();

    await vi.waitFor(() => {
      expect(webPushRow(container).dataset.webPushState).toBe('unsupported');
    });
    expect(webPushRow(container).querySelector('#usConnectWebPush')).toBeNull();
    expect(pushState.subscribeToPush).not.toHaveBeenCalled();
    expect(channelMocks.saveAlertRules).not.toHaveBeenCalled();
  });

  it('preserves the connected browser display while permission is usable', async () => {
    pushState.permission = 'granted';
    const container = await mount({
      channels: [
        {
          channelType: 'web_push',
          verified: true,
          linkedAt: 1,
          userAgent: 'Chrome/140.0',
        },
      ],
      alertRules: [],
    });
    const row = webPushRow(container);

    expect(row.classList.contains('us-notif-ch-on')).toBe(true);
    expect(row.textContent).toContain('Connected');
    expect(row.querySelector('.us-notif-disconnect')).not.toBeNull();
    expect(row.querySelector('#usConnectWebPush')).toBeNull();
  });

  it('keeps Remove available while warning a connected browser that permission is denied', async () => {
    pushState.permission = 'denied';
    const container = await mount({
      channels: [
        {
          channelType: 'web_push',
          verified: true,
          linkedAt: 1,
          userAgent: 'Chrome/140.0',
        },
      ],
      alertRules: [],
    });
    const row = webPushRow(container);

    expect(row.dataset.webPushState).toBe('denied');
    expect(row.querySelector('.us-notif-ch-sub')?.textContent).toBe(
      tt('components.proActivation.steps.alerts.blockedNote'),
    );
    expect(row.querySelector('.us-notif-disconnect')).not.toBeNull();
    expect(row.querySelector('#usConnectWebPush')).toBeNull();
  });
});
