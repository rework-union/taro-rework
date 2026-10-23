import type { Query } from './types';

export const isAbsolute = (url: string) => /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(url);
export const origin = (url: string) => url.match(/^(?:https?:)?\/\/[^/?#]+/i)?.[0].toLowerCase();

/** 避免依赖小程序环境中未必存在的 URL / URLSearchParams。 */
export function buildURL(baseURL: string, path: string, trailingSlash = true, query?: Query): string {
  let url = path;
  if (!isAbsolute(path)) {
    const index = path.search(/[?#]/);
    const pathname = index < 0 ? path : path.slice(0, index);
    const suffix = index < 0 ? '' : path.slice(index);
    const joined = `${baseURL.replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`;
    url = `${trailingSlash ? `${joined.replace(/\/+$/, '')}/` : joined}${suffix}`;
  }
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item !== undefined) pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(item === null ? '' : String(item))}`);
    }
  }
  if (!pairs.length) return url;
  const hashIndex = url.indexOf('#');
  const head = hashIndex < 0 ? url : url.slice(0, hashIndex);
  const hash = hashIndex < 0 ? '' : url.slice(hashIndex);
  const separator = head.includes('?') ? (/[?&]$/.test(head) ? '' : '&') : '?';
  return `${head}${separator}${pairs.join('&')}${hash}`;
}
