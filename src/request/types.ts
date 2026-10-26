import type Taro from '@tarojs/taro';

export type RequestPromise<T> = Promise<T> & { abort(): void };
export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue | readonly QueryValue[]>;
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Headers = Record<string, string>;

export interface RequestOptions {
  headers?: Headers;
  timeout?: number;
  /** 默认仅对相对路径和 baseURL 同源地址启用；外域需显式设为 true。 */
  auth?: boolean;
  silent?: boolean;
  /** 仅规范化相对路径，不修改绝对 URL。 */
  trailingSlash?: boolean;
}

export interface UploadOptions extends RequestOptions {
  filePath: string;
  name: string;
  fileName?: string;
  formData?: Record<string, string | number | boolean>;
  onProgress?: (event: Taro.UploadTask.OnProgressUpdateCallbackResult) => void;
}

export interface RequestConfig {
  baseURL: string;
  timeout?: number;
  headers?: Headers;
  trailingSlash?: boolean;
  tokenKey?: string;
  authScheme?: string;
  loginPage?: string;
  /** 返回新 access token；刷新接口必须使用 auth: false，避免递归刷新。 */
  refreshToken?: () => Promise<string>;
  /** 自定义登录流程；默认使用 reLaunch 跳到 loginPage。 */
  onUnauthorized?: () => void | Promise<void>;
}
