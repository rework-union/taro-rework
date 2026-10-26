import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { buildURL, RequestClient, RequestError } from './index';

const mock = vi.hoisted(() => ({
  request: vi.fn(), uploadFile: vi.fn(), getStorageSync: vi.fn(),
  setStorageSync: vi.fn(), removeStorageSync: vi.fn(),
  showToast: vi.fn(), reLaunch: vi.fn(),
}));
vi.mock('@tarojs/taro', () => ({ default: mock }));

type Response = { statusCode: number; data: unknown };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function task(response: Response = { statusCode: 200, data: {} }) {
  return Object.assign(Promise.resolve(response), { abort: vi.fn(), onProgressUpdate: vi.fn() });
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
let storage: Map<string, string>;
let client: RequestClient;

beforeEach(() => {
  vi.resetAllMocks();
  storage = new Map([['access_token', 'old']]);
  mock.getStorageSync.mockImplementation(key => storage.get(key));
  mock.setStorageSync.mockImplementation((key, value) => storage.set(key, value));
  mock.removeStorageSync.mockImplementation(key => storage.delete(key));
  mock.showToast.mockResolvedValue({});
  mock.reLaunch.mockResolvedValue({});
  mock.request.mockImplementation(() => task());
  mock.uploadFile.mockImplementation(() => task({ statusCode: 200, data: '{"id":1}' }));
  client = new RequestClient({ baseURL: 'https://api.example.com/v1/' });
});
afterEach(() => vi.useRealTimers());

describe('URL', () => {
  it.each([
    ['users', true, 'https://api.example.com/v1/users/'],
    ['/users/', true, 'https://api.example.com/v1/users/'],
    ['users?active=1#top', true, 'https://api.example.com/v1/users/?active=1#top'],
    ['users.json', false, 'https://api.example.com/v1/users.json'],
    ['https://cdn.example.com/file?x=1', true, 'https://cdn.example.com/file?x=1'],
    ['//cdn.example.com/file', true, '//cdn.example.com/file'],
  ])('joins %s', (path, slash, expected) => {
    expect(buildURL('https://api.example.com/v1/', path, slash)).toBe(expected);
  });
  it('encodes repeated arrays, null, booleans and existing query before hash', () => {
    expect(buildURL('https://api.example.com', 'users?x=1#top', true, {
      q: '中文 &', tag: ['a', 'b'], empty: null, skip: undefined, active: false,
    })).toBe('https://api.example.com/users/?x=1&q=%E4%B8%AD%E6%96%87%20%26&tag=a&tag=b&empty=&active=false#top');
  });
});

describe('requests', () => {
  it('unwraps typed GET responses and sends params only in query', async () => {
    mock.request.mockReturnValue(task({ statusCode: 200, data: { id: 1 } }));
    const result = client.get<{ id: number }>('users', { page: 2 });
    expectTypeOf(result).resolves.toEqualTypeOf<{ id: number }>();
    expectTypeOf(client.get('types')).resolves.toEqualTypeOf<unknown>();
    await expect(result).resolves.toEqual({ id: 1 });
    expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.example.com/v1/users/?page=2', data: undefined,
      header: { authorization: 'Bearer old' }, timeout: 15_000, method: 'GET',
    }));
  });
  it.each(['post', 'put', 'patch', 'delete'] as const)('%s sends body', async method => {
    await client[method]('users', { id: 1 }, { timeout: 3_000 });
    expect(mock.request).toHaveBeenCalledWith(expect.objectContaining({
      method: method.toUpperCase(), data: { id: 1 }, timeout: 3_000,
    }));
  });
  it('allows disabling slash normalization', async () => {
    await client.get('users', undefined, { trailingSlash: false });
    expect(mock.request.mock.calls[0][0].url).toBe('https://api.example.com/v1/users');
  });
  it('supports public requests without storage access or authorization', async () => {
    await client.post('login', {}, { auth: false, headers: { Authorization: 'stale' } });
    expect(mock.getStorageSync).not.toHaveBeenCalled();
    expect(mock.request.mock.calls[0][0].header).toEqual({});
  });
  it('does not leak token to external absolute URLs', async () => {
    await client.get('https://cdn.example.com/file');
    expect(mock.request.mock.calls[0][0]).toMatchObject({ url: 'https://cdn.example.com/file', header: {} });
    await client.get('https://api.example.com/me');
    expect(mock.request.mock.calls[1][0].header.authorization).toBe('Bearer old');
    await client.get('https://trusted.example.com/me', undefined, { auth: true });
    expect(mock.request.mock.calls[2][0].header.authorization).toBe('Bearer old');
  });
  it('merges headers without duplicate names', async () => {
    client = new RequestClient({ baseURL: '/api', headers: { 'Content-Type': 'a', 'X-App': 'a' } });
    await client.get('users', undefined, { headers: { 'content-type': 'b', 'X-App': 'b' } });
    expect(mock.request.mock.calls[0][0].header).toEqual({
      'content-type': 'b', 'x-app': 'b', authorization: 'Bearer old',
    });
  });
  it('unwraps 204', async () => {
    mock.request.mockReturnValue(task({ statusCode: 204, data: undefined }));
    await expect(client.delete('users/1')).resolves.toBeUndefined();
  });
  it.each([400, 403, 404, 422, 500, 503])('normalizes HTTP %s with original body', async statusCode => {
    mock.request.mockReturnValue(task({ statusCode, data: { detail: '失败' } }));
    await expect(client.get('users')).rejects.toMatchObject({
      name: 'RequestError', kind: 'http', statusCode, data: { detail: '失败' }, message: '失败',
    });
    expect(mock.showToast).toHaveBeenCalledWith({ title: '失败', icon: 'none' });
  });
  it.each([
    ['request:fail offline', 'network'], ['request:fail timeout', 'timeout'], ['request:fail abort', 'abort'],
  ])('normalizes %s', async (errMsg, kind) => {
    mock.request.mockImplementation(() => Object.assign(Promise.reject({ errMsg }), { abort: vi.fn() }));
    await expect(client.get('users')).rejects.toMatchObject({ name: 'RequestError', kind, statusCode: 0 });
    if (kind === 'abort') expect(mock.showToast).not.toHaveBeenCalled();
  });
  it('normalizes synchronous native errors and respects silent', async () => {
    mock.request.mockImplementation(() => { throw new Error('native failure'); });
    await expect(client.get('users', undefined, { silent: true })).rejects.toBeInstanceOf(RequestError);
    expect(mock.showToast).not.toHaveBeenCalled();
  });
  it('preserves errors if toast fails', async () => {
    mock.request.mockReturnValue(task({ statusCode: 500, data: 'error' }));
    mock.showToast.mockRejectedValue(new Error('toast failure'));
    await expect(client.get('users')).rejects.toMatchObject({ statusCode: 500, data: 'error' });
  });
  it('enforces timeout even when native task does not settle', async () => {
    vi.useFakeTimers();
    const pending = Object.assign(new Promise<Response>(() => {}), { abort: vi.fn() });
    mock.request.mockReturnValue(pending);
    const result = client.get('users', undefined, { timeout: 50 });
    const assertion = expect(result).rejects.toMatchObject({ kind: 'timeout', statusCode: 0 });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(pending.abort).toHaveBeenCalledOnce();
  });
});

describe('authentication', () => {
  const unauthorized = { statusCode: 401, data: { detail: 'expired' } };
  it('deduplicates navigation and clears token once across concurrent 401s', async () => {
    mock.request.mockImplementation(() => task(unauthorized));
    const results = await Promise.allSettled([client.get('a'), client.get('b'), client.get('c')]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(mock.removeStorageSync).toHaveBeenCalledOnce();
    expect(mock.reLaunch).toHaveBeenCalledExactlyOnceWith({ url: '/pages/login/index' });
    storage.set('access_token', 'new-login');
    await expect(client.get('a')).rejects.toMatchObject({ statusCode: 401 });
    expect(mock.reLaunch).toHaveBeenCalledTimes(2);
  });
  it('does not handle auth:false 401 as session expiration', async () => {
    mock.request.mockReturnValue(task(unauthorized));
    await expect(client.post('login', {}, { auth: false })).rejects.toMatchObject({ statusCode: 401 });
    expect(mock.reLaunch).not.toHaveBeenCalled();
    expect(storage.get('access_token')).toBe('old');
  });
  it('shares refresh, persists the new token and replays concurrent requests', async () => {
    const refreshing = deferred<string>();
    const refreshToken = vi.fn(() => refreshing.promise);
    client = new RequestClient({ baseURL: '/api', refreshToken });
    mock.request.mockImplementation(({ header }) => task(header.authorization === 'Bearer old'
      ? unauthorized : { statusCode: 200, data: 'ok' }));
    const requests = [client.get('a'), client.get('b'), client.post('c', { id: 1 })];
    await flush();
    expect(refreshToken).toHaveBeenCalledOnce();
    refreshing.resolve('new');
    await expect(Promise.all(requests)).resolves.toEqual(['ok', 'ok', 'ok']);
    expect(storage.get('access_token')).toBe('new');
    expect(mock.request).toHaveBeenCalledTimes(6);
    expect(mock.request.mock.calls.at(-1)?.[0]).toMatchObject({ method: 'POST', data: { id: 1 } });
    expect(mock.showToast).not.toHaveBeenCalled();
  });
  it('does not refresh again for an old 401 arriving after refresh completes', async () => {
    const late = deferred<Response>();
    const refreshToken = vi.fn().mockResolvedValue('new');
    client = new RequestClient({ baseURL: '/api', refreshToken });
    mock.request.mockReturnValueOnce(task(unauthorized))
      .mockReturnValueOnce(Object.assign(late.promise, { abort: vi.fn() }))
      .mockImplementation(() => task({ statusCode: 200, data: 'ok' }));
    const first = client.get('a');
    const second = client.get('b');
    await first;
    late.resolve(unauthorized);
    await expect(second).resolves.toBe('ok');
    expect(refreshToken).toHaveBeenCalledOnce();
  });
  it('retries each request only once', async () => {
    const refreshToken = vi.fn().mockResolvedValue('new');
    client = new RequestClient({ baseURL: '/api', refreshToken });
    mock.request.mockImplementation(() => task(unauthorized));
    await expect(client.get('a')).rejects.toMatchObject({ statusCode: 401 });
    expect(mock.request).toHaveBeenCalledTimes(2);
    expect(refreshToken).toHaveBeenCalledOnce();
    expect(mock.reLaunch).toHaveBeenCalledOnce();
    expect(storage.has('access_token')).toBe(false);
  });
  it('normalizes refresh failure and navigates once', async () => {
    const refreshToken = vi.fn().mockRejectedValue(new Error('refresh offline'));
    client = new RequestClient({ baseURL: '/api', refreshToken });
    mock.request.mockImplementation(() => task(unauthorized));
    await Promise.all([
      expect(client.get('a')).rejects.toBeInstanceOf(RequestError),
      expect(client.get('b')).rejects.toBeInstanceOf(RequestError),
    ]);
    expect(refreshToken).toHaveBeenCalledOnce();
    expect(mock.reLaunch).toHaveBeenCalledOnce();
  });
  it('supports a custom login handler and preserves the HTTP error if it fails', async () => {
    const onUnauthorized = vi.fn().mockRejectedValue(new Error('navigation failed'));
    client = new RequestClient({ baseURL: '/api', onUnauthorized });
    mock.request.mockReturnValue(task(unauthorized));
    await expect(client.get('a')).rejects.toMatchObject({ statusCode: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(mock.reLaunch).not.toHaveBeenCalled();
  });
  it('supports refresh using a public endpoint on the same instance', async () => {
    client = new RequestClient({
      baseURL: '/api',
      refreshToken: async () => (await client.post<{ access: string }>('refresh', {}, { auth: false, silent: true })).access,
    });
    mock.request.mockImplementation(({ url, header }) => task(url.includes('refresh')
      ? { statusCode: 200, data: { access: 'new' } }
      : header.authorization === 'Bearer old' ? unauthorized : { statusCode: 200, data: 'ok' }));
    await expect(client.get('a')).resolves.toBe('ok');
    expect(mock.request).toHaveBeenCalledTimes(3);
  });
});

describe('cancellation and uploads', () => {
  it('aborts before dispatch without starting a request', async () => {
    const result = client.get('users');
    result.abort();
    result.abort();
    await expect(result).rejects.toMatchObject({ kind: 'abort' });
    expect(mock.request).not.toHaveBeenCalled();
    expect(mock.showToast).not.toHaveBeenCalled();
  });
  it('aborts the native task and rejects even if the task never settles', async () => {
    const pending = Object.assign(new Promise<Response>(() => {}), { abort: vi.fn() });
    mock.request.mockReturnValue(pending);
    const result = client.get('users');
    await flush();
    result.abort();
    await expect(result).rejects.toMatchObject({ kind: 'abort' });
    expect(pending.abort).toHaveBeenCalledOnce();
    expect(mock.showToast).not.toHaveBeenCalled();
  });
  it('cancels a waiter without cancelling shared refresh or replaying it', async () => {
    const refreshing = deferred<string>();
    client = new RequestClient({ baseURL: '/api', refreshToken: () => refreshing.promise });
    mock.request.mockImplementation(({ header }) => task(header.authorization === 'Bearer old'
      ? { statusCode: 401, data: {} } : { statusCode: 200, data: 'ok' }));
    const cancelled = client.get('a');
    const active = client.get('b');
    await flush();
    cancelled.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: 'abort' });
    refreshing.resolve('new');
    await expect(active).resolves.toBe('ok');
    expect(mock.request).toHaveBeenCalledTimes(3);
  });
  it('does not abort after completion', async () => {
    const native = task();
    mock.request.mockReturnValue(native);
    const result = client.get('a');
    await result;
    result.abort();
    expect(native.abort).not.toHaveBeenCalled();
  });
  it('uploads multipart, parses JSON, forwards progress and strips Content-Type', async () => {
    client = new RequestClient({ baseURL: '/api', headers: { 'Content-Type': 'application/json' } });
    const native = task({ statusCode: 201, data: '{"id":1}' });
    mock.uploadFile.mockReturnValue(native);
    const onProgress = vi.fn();
    await expect(client.upload('files', {
      filePath: '/tmp/a.png', name: 'file', formData: { id: 1 }, onProgress,
    })).resolves.toEqual({ id: 1 });
    expect(mock.uploadFile).toHaveBeenCalledWith(expect.objectContaining({
      url: '/api/files/', header: { authorization: 'Bearer old' },
      filePath: '/tmp/a.png', name: 'file', formData: { id: 1 }, timeout: 15_000,
    }));
    expect(native.onProgressUpdate).toHaveBeenCalledWith(onProgress);
  });
  it('retains plain upload response text', async () => {
    mock.uploadFile.mockReturnValue(task({ statusCode: 200, data: 'ok' }));
    await expect(client.upload('files', { filePath: '/tmp/a', name: 'file' })).resolves.toBe('ok');
  });
  it('refreshes and replays uploads with original file and form data', async () => {
    client = new RequestClient({ baseURL: '/api', refreshToken: async () => 'new' });
    mock.uploadFile.mockReturnValueOnce(task({ statusCode: 401, data: '{"detail":"expired"}' }))
      .mockReturnValueOnce(task({ statusCode: 201, data: '{"id":1}' }));
    await expect(client.upload('files', { filePath: '/tmp/a', name: 'file', formData: { x: 1 } })).resolves.toEqual({ id: 1 });
    expect(mock.uploadFile.mock.calls[1][0]).toMatchObject({
      header: { authorization: 'Bearer new' }, filePath: '/tmp/a', formData: { x: 1 },
    });
  });
  it('cancels uploads', async () => {
    const pending = Object.assign(new Promise<Response>(() => {}), { abort: vi.fn() });
    mock.uploadFile.mockReturnValue(pending);
    const result = client.upload('files', { filePath: '/tmp/a', name: 'file' });
    await flush();
    result.abort();
    await expect(result).rejects.toMatchObject({ kind: 'abort' });
    expect(pending.abort).toHaveBeenCalledOnce();
  });
});
