import { describe, expect, jest, test } from '@jest/globals';
import { Linking } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import type { LinkPreviewMetadata } from '@/data/repositories/contracts';
import {
  firstPreviewUrl,
  maxPreviewUrlLength,
  normalizePreviewUrl,
  previewSiteLabel,
} from '@/features/chat/link-preview';
import { LinkPreviewCard } from '@/features/chat/link-preview-card';

const mockLoadLinkPreview = jest.fn<(url: string) => Promise<LinkPreviewMetadata | null>>(
  async () => null,
);

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/state/workspace', () => ({
  useWorkspace: () => ({ loadLinkPreview: (url: string) => mockLoadLinkPreview(url) }),
}));

describe('finding the link in a message', () => {
  test.each([
    ['Look at https://example.com/story', 'https://example.com/story'],
    ['www.example.com is the one', 'https://www.example.com/'],
    ['example.com/deals', 'https://example.com/deals'],
    ['Read this: https://news.example.co.uk/a/b?ref=1', 'https://news.example.co.uk/a/b?ref=1'],
  ])('reads %s', (text, expected) => {
    expect(firstPreviewUrl(text)).toBe(expected);
  });

  test('takes only the first, because a wall of cards is worse than none', () => {
    expect(firstPreviewUrl('https://one.example.com and https://two.example.com'))
      .toBe('https://one.example.com/');
  });

  test('leaves the sentence’s own punctuation out of the address', () => {
    expect(firstPreviewUrl('Have a look at https://example.com/story.')).toBe('https://example.com/story');
    expect(firstPreviewUrl('(see https://example.com/story)')).toBe('https://example.com/story');
    expect(firstPreviewUrl('"https://example.com/story",')).toBe('https://example.com/story');
  });

  test.each([
    ['no link at all here'],
    [''],
    ['ask me at hello@example.com'],
    ['version 1.2 shipped'],
    ['http://localhost:3000/admin'],
    ['https://127.0.0.1/secrets'],
    ['https://192.168.1.1/router'],
    ['https://metadata.google.internal/computeMetadata/v1/'],
    ['https://printer.local/status'],
    ['file:///etc/passwd'],
    ['javascript:alert(1)'],
    ['https://user:pass@example.com/'],
  ])('finds nothing worth a card in %s', (text) => {
    expect(firstPreviewUrl(text)).toBeNull();
  });

  test('drops the fragment, which is the reader’s business alone', () => {
    expect(normalizePreviewUrl('https://example.com/doc#section-4')).toBe('https://example.com/doc');
  });

  test('upgrades plain http, since we are the one making the request', () => {
    expect(normalizePreviewUrl('http://example.com/a')).toBe('https://example.com/a');
  });

  test('refuses an address longer than we are willing to carry', () => {
    expect(normalizePreviewUrl(`https://example.com/${'a'.repeat(maxPreviewUrlLength)}`)).toBeNull();
    expect(normalizePreviewUrl('')).toBeNull();
    expect(normalizePreviewUrl(undefined as unknown as string)).toBeNull();
    expect(firstPreviewUrl(undefined as unknown as string)).toBeNull();
  });

  test('labels the card with the site’s own name, or its host', () => {
    expect(previewSiteLabel('https://www.example.com/a', 'Example Daily')).toBe('Example Daily');
    expect(previewSiteLabel('https://www.example.com/a', '  ')).toBe('example.com');
    expect(previewSiteLabel('https://news.example.com/a')).toBe('news.example.com');
    expect(previewSiteLabel('not a url')).toBe('');
  });
});

describe('the card under the message', () => {
  test('shows what the page calls itself and opens it when tapped', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockImplementation(async () => undefined);
    mockLoadLinkPreview.mockImplementation(async () => ({
      url: 'https://example.com/story',
      title: 'The north gate is closed',
      siteName: 'Example Daily',
      // What arrives is a signed link to our own copy: the gateway fetched the
      // thumbnail alongside the page, so the site is never told who is reading.
      imageUrl: 'https://storage.example/link-preview-images/abc.png?token=x',
      status: 'ready',
    }));
    const view = await render(<LinkPreviewCard url="https://example.com/story" />);

    await waitFor(() => expect(screen.getByText('The north gate is closed')).toBeTruthy());
    expect(screen.getByText('Example Daily')).toBeTruthy();
    const thumbnails = () => view.root!.queryAll(
      (node) => typeof node.props?.source?.uri === 'string',
    );
    const image = thumbnails()[0];
    expect(image?.props.source).toEqual({
      uri: 'https://storage.example/link-preview-images/abc.png?token=x',
    });

    // A signed link that has expired leaves the words, not a broken picture.
    await act(async () => { image?.props.onError?.(); });
    expect(thumbnails()).toHaveLength(0);
    expect(screen.getByText('The north gate is closed')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('The north gate is closed · Example Daily'));
    expect(openURL).toHaveBeenCalledWith('https://example.com/story');
  });

  test('falls back to the host when the page never says what it is called', async () => {
    mockLoadLinkPreview.mockImplementation(async () => ({
      url: 'https://news.example.com/story',
      title: 'The north gate is closed',
      siteName: null,
      imageUrl: null,
      status: 'ready',
    }));
    const view = await render(<LinkPreviewCard url="https://news.example.com/story" />);
    await waitFor(() => expect(view.getByText('The north gate is closed')).toBeTruthy());
    expect(view.getByText('news.example.com')).toBeTruthy();
    expect(view.getByLabelText('The north gate is closed · news.example.com')).toBeTruthy();
  });

  test('a card whose message scrolls away before the answer arrives sets no state', async () => {
    let settle: ((value: LinkPreviewMetadata | null) => void) | undefined;
    mockLoadLinkPreview.mockImplementation(() => new Promise((resolve) => {
      settle = resolve;
    }));
    const view = await render(<LinkPreviewCard url="https://example.com/slow" />);
    await view.unmount();
    settle?.({
      url: 'https://example.com/slow',
      title: 'Too late',
      siteName: null,
      imageUrl: null,
      status: 'ready',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('shows nothing at all when the page could not be read', async () => {
    mockLoadLinkPreview.mockImplementation(async () => ({
      url: 'https://example.com/story',
      title: null,
      siteName: null,
      imageUrl: null,
      status: 'unavailable',
    }));
    await render(<LinkPreviewCard url="https://example.com/story" />);
    await waitFor(() => expect(mockLoadLinkPreview).toHaveBeenCalledWith('https://example.com/story'));
    expect(screen.queryByText('example.com')).toBeNull();
  });

  test('shows nothing when the request itself did not come back', async () => {
    mockLoadLinkPreview.mockImplementation(async () => null);
    await render(<LinkPreviewCard url="https://example.com/story" />);
    await waitFor(() => expect(mockLoadLinkPreview).toHaveBeenCalled());
    expect(screen.queryByRole('link')).toBeNull();
  });
});
