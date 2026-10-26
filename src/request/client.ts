import Taro from '@tarojs/taro';
import { httpError, normalizeError, RequestError } from './error';
import type { Headers, Method, Query, RequestConfig, RequestOptions, RequestPromise, UploadOptions } from './types';
import { buildURL, isAbsolute, origin } from './url';

type Task = { abort(): void };
type Context = { aborted: boolean; task?: Task; cancel?: () => void };
type Response = { statusCode: number; data: unknown };
type Transport = (url: string, headers: Headers, timeout: number, context: Context) => Promise<Response>;

/** 一个实例对应一个 API 和登录态；请在应用中复用实例。 */
export class RequestClient {
  private refreshPromise?: Promise<string>;
  private invalidated = false;
  private invalidToken?: string;
  private readonly config: Required<Pick<RequestConfig, 'timeout' | 'tokenKey' | 'authScheme' | 'trailingSlash' | 'loginPage'>> & RequestConfig;

  constructor(config: RequestConfig) {
    this.config = {
      timeout: 15_000,
      tokenKey: 'access_token',
      authScheme: 'Bearer',
      trailingSlash: true,
      loginPage: '/pages/login/index',
      ...config,
    };
  }

  get<T = unknown>(url: string, query?: Query, options: RequestOptions = {}): RequestPromise<T> {
    return this.request<T>('GET', url, query, options);
  }

  post<T = unknown>(url: string, data?: unknown, options: RequestOptions = {}): RequestPromise<T> {
    return this.request<T>('POST', url, data, options);
  }

  put<T = unknown>(url: string, data?: unknown, options: RequestOptions = {}): RequestPromise<T> {
    return this.request<T>('PUT', url, data, options);
  }

  patch<T = unknown>(url: string, data?: unknown, options: RequestOptions = {}): RequestPromise<T> {
    return this.request<T>('PATCH', url, data, options);
  }

  delete<T = unknown>(url: string, data?: unknown, options: RequestOptions = {}): RequestPromise<T> {
    return this.request<T>('DELETE', url, data, options);
  }

  request<T = unknown>(method: 'GET', url: string, data?: Query, options?: RequestOptions): RequestPromise<T>;
  request<T = unknown>(method: Exclude<Method, 'GET'>, url: string, data?: unknown, options?: RequestOptions): RequestPromise<T>;
  request<T = unknown>(method: Method, url: string, data?: unknown, options: RequestOptions = {}): RequestPromise<T> {
    return this.execute<T>(url, options, (target, headers, timeout, context) => {
      const targetURL = method === 'GET' ? buildURL('', target, false, data as Query | undefined) : target;
      return this.send(context, timeout, () => Taro.request({
        url: targetURL, method, data: method === 'GET' ? undefined : data,
        header: headers, timeout,
      }));
    });
  }

  upload<T = unknown>(url: string, options: UploadOptions): RequestPromise<T> {
    return this.execute<T>(url, options, async (target, headers, timeout, context) => {
      // multipart 的 boundary 由运行时生成，不能复用 JSON Content-Type。
      const uploadHeaders = { ...headers };
      for (const key of Object.keys(uploadHeaders)) {
        if (key.toLowerCase() === 'content-type') delete uploadHeaders[key];
      }
      const response = await this.send(context, timeout, () => {
        const task = Taro.uploadFile({
          url: target, header: uploadHeaders, timeout,
          filePath: options.filePath, name: options.name,
          fileName: options.fileName, formData: options.formData,
        });
        if (options.onProgress) task.onProgressUpdate(options.onProgress);
        return task;
      });
      if (typeof response.data === 'string') {
        try { return { ...response, data: JSON.parse(response.data) as unknown }; }
        catch { /* 非 JSON 响应按文本返回。 */ }
      }
      return response;
    });
  }

  private readToken(): string | undefined {
    const token: unknown = Taro.getStorageSync(this.config.tokenKey);
    return typeof token === 'string' && token ? token : undefined;
  }

  private execute<T>(path: string, options: RequestOptions, transport: Transport): RequestPromise<T> {
    const context: Context = { aborted: false };
    let settled = false;
    let rejectOuter: (reason: RequestError) => void;
    const promise = new Promise<T>((resolve, reject) => {
      rejectOuter = reject;
      // 推迟到 microtask，确保调用方立即 abort 时不会发起请求。
      void Promise.resolve().then(async () => {
        try {
          const url = buildURL(this.config.baseURL, path, options.trailingSlash ?? this.config.trailingSlash);
          const auth = options.auth ?? (!isAbsolute(path) || (!!origin(url) && origin(url) === origin(this.config.baseURL)));
          const timeout = options.timeout ?? this.config.timeout;
          if (!Number.isFinite(timeout) || timeout <= 0) throw new RequestError('timeout 必须为正数', 'unknown');
          for (let attempt = 0; attempt < 2; attempt++) {
            if (context.aborted) throw new RequestError('请求已取消', 'abort');
            const token = auth ? this.readToken() : undefined;
            if (token && token !== this.invalidToken) this.invalidated = false;
            const headers: Headers = {};
            // 大小写不敏感地合并，避免重复 Authorization / Content-Type。
            for (const [key, value] of Object.entries({ ...this.config.headers, ...options.headers })) {
              headers[key.toLowerCase()] = value;
            }
            delete headers.authorization;
            if (token) headers.authorization = `${this.config.authScheme} ${token}`.trim();
            const response = await transport(url, headers, timeout, context);
            if (context.aborted) throw new RequestError('请求已取消', 'abort');
            if (response.statusCode >= 200 && response.statusCode < 300) {
              resolve(response.data as T);
              return;
            }
            const error = httpError(response);
            if (response.statusCode !== 401 || !auth) throw error;
            const currentToken = this.readToken();
            // 已有其他请求刷新成功：复用新 token，避免较晚返回的旧 401 再次刷新。
            if (attempt === 0 && currentToken && currentToken !== token) continue;
            if (attempt === 0 && this.config.refreshToken && !this.invalidated) {
              try {
                await this.refresh(token);
              } catch (refreshError) {
                await this.invalidate(token);
                throw refreshError;
              }
              continue;
            }
            await this.invalidate(token);
            throw error;
          }
        } catch (cause) {
          const error = normalizeError(cause);
          if (!context.aborted && !options.silent && error.kind !== 'abort') {
            try { await Taro.showToast({ title: error.message, icon: 'none' }); }
            catch { /* 提示失败不能覆盖请求错误。 */ }
          }
          reject(error);
        } finally {
          settled = true;
        }
      });
    }) as RequestPromise<T>;
    promise.abort = () => {
      if (settled || context.aborted) return;
      context.aborted = true;
      rejectOuter(new RequestError('请求已取消', 'abort'));
      context.cancel?.();
      try { context.task?.abort(); } catch { /* Promise 已取消。 */ }
    };
    return promise;
  }

  private send(context: Context, timeout: number, start: () => PromiseLike<Response> & Task): Promise<Response> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        context.cancel = undefined;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new RequestError('请求超时', 'timeout'));
        try { context.task?.abort(); } catch { /* 保留超时错误。 */ }
      }, timeout);
      context.cancel = () => {
        cleanup();
        reject(new RequestError('请求已取消', 'abort'));
      };
      try {
        const task = start();
        context.task = task;
        void Promise.resolve(task).then(
          response => { cleanup(); resolve(response); },
          error => { cleanup(); reject(error); },
        );
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  private refresh(previousToken?: string): Promise<string> {
    if (!this.refreshPromise) {
      this.refreshPromise = Promise.resolve().then(() => this.config.refreshToken!()).then(token => {
        if (!token || typeof token !== 'string') throw new RequestError('刷新 token 失败：未返回 access token', 'unknown');
        const currentToken = this.readToken();
        if (currentToken && currentToken !== previousToken) return currentToken;
        Taro.setStorageSync(this.config.tokenKey, token);
        return token;
      }).finally(() => { this.refreshPromise = undefined; });
    }
    return this.refreshPromise;
  }

  private async invalidate(token?: string): Promise<void> {
    if (this.invalidated) return;
    // 不清除请求期间由登录流程写入的新 token。
    const currentToken = this.readToken();
    if (currentToken && currentToken !== token) return;
    this.invalidated = true;
    this.invalidToken = token;
    try { Taro.removeStorageSync(this.config.tokenKey); } catch { /* 继续跳转登录。 */ }
    try {
      if (this.config.onUnauthorized) await this.config.onUnauthorized();
      else await Taro.reLaunch({ url: this.config.loginPage });
    } catch { /* 导航失败不能覆盖原请求错误。 */ }
  }
}
