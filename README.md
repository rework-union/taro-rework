# taro-rework

面向 Taro 4 的 TypeScript 请求库，支持 DRF 路径、统一错误、并发 token 刷新、文件上传与请求取消。提供 ESM / CommonJS 入口和类型声明，Taro 由使用方提供。

## 安装与使用

发布到 npm 后，在已有 Taro 4 应用中安装：

```sh
pnpm add taro-rework
```

```ts
import Taro from '@tarojs/taro';
import { RequestClient, RequestError } from 'taro-rework';

export const api = new RequestClient({
  baseURL: 'https://api.example.com/api',
  timeout: 15_000,
  tokenKey: 'access_token',
  authScheme: 'Bearer', // DRF TokenAuthentication 可改为 'Token'
  trailingSlash: true,
  loginPage: '/pages/login/index',
});

interface User { id: number; username: string }

const users = await api.get<User[]>('/users', { page: 1 });
// GET https://api.example.com/api/users/?page=1
const user = await api.post<User>('/users', { username: 'alice' });
await api.patch<User>(`/users/${user.id}`, { username: 'bob' });
await api.delete<void>(`/users/${user.id}`);

try {
  await api.get<User>('/me', undefined, { silent: true, timeout: 5_000 });
} catch (error) {
  if (error instanceof RequestError) {
    console.log(error.kind, error.statusCode, error.data);
  }
}
```

一个后端复用一个实例，以共享刷新任务和登录跳转状态。响应体原样返回，不预设 `{ code, data }` 等业务包装结构；泛型默认为 `unknown`，只提供编译期类型，不校验服务端数据。

### 方法和参数

| 方法 | 参数 |
| --- | --- |
| `get<T>(url, query?, options?)` | query 写入 URL，不发送 body |
| `post<T> / put<T> / patch<T> / delete<T>(url, body?, options?)` | body 交给 Taro 发送 |
| `request<T>(method, url, data?, options?)` | 通用入口，GET 的 data 为 query |
| `upload<T>(url, options)` | `Taro.uploadFile` 上传，支持进度回调 |

`options` 支持 `headers`、`timeout`（毫秒）、`auth`、`silent`、`trailingSlash`。实例也可设置默认 `headers`。

相对路径拼接到 baseURL 路径后，不使用浏览器的根路径替换语义。默认在相对路径的 query/hash 前补尾斜杠；`trailingSlash: false` 保留原路径斜杠，适用于静态资源或不要求斜杠的后端。绝对 URL（包括 `//host/path`）的路径保持原样，GET 参数仍会附加。baseURL 应为不含 query/hash 的 API 前缀。

query 数组编码为重复键，例如 `tag=a&tag=b`；`undefined` 忽略，`null` 编码为空值，中文和特殊字符会转义。复杂嵌套对象应由调用方转换为字符串。

默认只向相对路径、与 baseURL 同源的绝对 URL 注入 token。向其他可信域名发请求时，需显式设置 `auth: true`。请求头大小写不敏感；`Authorization` 由 token 配置统一管理，手动传入的同名头会移除，`auth: false` 保证不携带它。

### 登录和刷新 token

登录、注册、刷新接口必须设置 `auth: false`。登录后将 token 存入配置的 `tokenKey`：

```ts
const session = await api.post<{ access: string; refresh: string }>(
  '/auth/login', { username: 'alice', password: 'password' }, { auth: false },
);
Taro.setStorageSync('access_token', session.access);
Taro.setStorageSync('refresh_token', session.refresh);
```

按后端协议注入刷新回调，成功返回新的 access token。以下以 DRF SimpleJWT 为例：

```ts
const publicApi = new RequestClient({ baseURL: 'https://api.example.com/api' });

export const authenticatedApi = new RequestClient({
  baseURL: 'https://api.example.com/api',
  refreshToken: async () => {
    const result = await publicApi.post<{ access: string; refresh?: string }>(
      '/token/refresh',
      { refresh: Taro.getStorageSync('refresh_token') },
      { auth: false, silent: true },
    );
    // 后端启用 refresh token rotation 时，同时保存新的 refresh token。
    if (result.refresh) Taro.setStorageSync('refresh_token', result.refresh);
    return result.access;
  },
  onUnauthorized: async () => {
    Taro.removeStorageSync('refresh_token');
    await Taro.reLaunch({ url: '/pages/login/index' });
  },
});
```

并发 401 共用一个刷新 Promise。新 access token 自动写入 storage，原请求最多重放一次，body、文件路径和参数保留。较晚返回的旧 token 401 直接使用已刷新的 token 重放。

未配置刷新回调、刷新失败，或重放仍为 401 时，清除 access token 并执行 `onUnauthorized`；默认跳转到 `loginPage`。同一失效会话只触发一次清理和跳转，新 token 写入后重新允许处理后续会话过期。`auth: false` 的 401 直接抛错。刷新失败会清理会话，包括刷新接口网络失败的情况。

### 统一错误

所有请求失败均拒绝为 `RequestError`：

| 字段 | 含义 |
| --- | --- |
| `kind` | `http`、`network`、`timeout`、`abort`、`unknown` |
| `statusCode` | HTTP 状态码；没有 HTTP 响应时为 `0` |
| `data` | 原始错误响应体，没有响应时为 `undefined` |
| `message` | 优先使用响应的字符串 `detail` / `message` |
| `cause` | 原生失败原因，可选 |

2xx 返回 body，其他 HTTP 状态均抛错。默认 `Taro.showToast` 提示最终失败；成功刷新过程中不提示。`silent: true` 只关闭提示，不关闭抛错、刷新或登录跳转。主动取消不提示。并发失败按请求提示，如需页面自行合并提示，可设置 `silent: true`。

### 上传和取消

```ts
const upload = api.upload<{ url: string }>('/files', {
  filePath: '/tmp/avatar.png',
  name: 'file',
  formData: { category: 'avatar' },
  onProgress: ({ progress }) => console.log(progress),
});
const file = await upload;

const pending = api.get<User[]>('/users');
// 在页面卸载等时机调用，并正常处理拒绝。
pending.abort();
try {
  await pending;
} catch (error) {
  if (!(error instanceof RequestError && error.kind === 'abort')) throw error;
}
```

上传自动移除 Content-Type，让 Taro 设置 multipart boundary；响应字符串尝试解析 JSON，非 JSON 保留文本。上传共用认证、刷新、超时和错误处理。

方法返回 `Promise<T> & { abort(): void }`，可直接 `await`。保留原返回值后调用 `abort()`；`.then()` 或 `async` 包装后的新 Promise 不保留此方法。取消会立即拒绝并调用当前原生 task 的 `abort()`，也可取消等待刷新的请求，不影响其他请求的刷新；被取消的请求不会重放。服务端已经执行的操作无法通过取消撤销。

超时为每次网络尝试的时间，默认 15 秒，可逐个覆盖；刷新及重放会增加总等待时间。原生 timeout 外还有定时器兜底。各端 API 支持情况参见 [Taro.request](https://docs.taro.zone/docs/apis/network/request/)、[Taro.uploadFile](https://docs.taro.zone/docs/apis/network/upload/uploadFile) 和 [RequestTask.abort](https://docs.taro.zone/docs/apis/network/request/RequestTask)。

## 开发

要求 Node.js >= 22.12，使用 `packageManager` 固定的 pnpm 10。通过 Corepack 或 [pnpm 官方安装方式](https://pnpm.io/installation) 安装 pnpm：

```sh
corepack enable
corepack prepare pnpm@10.34.7 --activate
pnpm install
pnpm dev           # 监听源码并重新构建库
pnpm typecheck
pnpm test
pnpm build
```

请求模块集中在 `src/request/`，相关实现和测试放在一起：

```text
src/
├── index.ts                 # npm 包入口
└── request/
    ├── index.ts             # 请求模块公开导出
    ├── client.ts            # RequestClient：请求、认证、上传和取消
    ├── types.ts             # 公开配置及参数类型
    ├── error.ts             # RequestError 和错误转换
    ├── url.ts               # URL 拼接和 query 编码
    └── request.test.ts       # mock Taro 的行为测试
```

`dist/` 为忽略提交的构建产物。仓库是库项目，`pnpm dev` 不启动页面服务。

## npm 发布

```sh
pnpm typecheck
pnpm test
pnpm pack          # 自动构建，并在本地生成 tarball 供检查和安装验证
pnpm login --registry=https://registry.npmjs.org/
pnpm publish --access public
```

发布前确认 npm 上包名 `taro-rework` 可用或有对应发布权限，并更新版本号。`prepublishOnly` 执行类型检查与测试，`prepack` 自动构建；仅发布 `dist/`、package.json、README 和 LICENSE。构建输出 ESM、CommonJS 及各自声明文件，`@tarojs/taro` 保持 external / peer dependency，不打入包中。

自动测试覆盖 URL/query、所有方法、错误分类、超时、并发 401、刷新重放、上传与取消。发布前还应在实际 Taro H5 和目标小程序中验证登录跳转、原生上传进度、请求取消及合法域名配置。

### GitHub Actions 自动发布

仓库已配置 `.github/workflows/publish.yml`。推送 `v*` tag 时，工作流检查 tag 与 package.json 版本一致，使用 Node.js 24 和固定版本的 pnpm 安装依赖，然后由 npm 发布钩子依次完成类型检查、测试和构建。任何一步失败都会停止发布。正式版发布到 `latest`，带连字符的预发布版本（例如 `0.2.0-beta.1`）发布到 `next`。

认证使用 [npm Trusted Publishing（OIDC）](https://docs.npmjs.com/trusted-publishers/)，不需要配置 `NPM_TOKEN`。工作流使用支持 OIDC 的 npm 11，并授予 `id-token: write`；依赖安装和开发仍使用 pnpm。

首次设置：

1. 将源码、`pnpm-lock.yaml` 和工作流提交并推送到 `rework-union/taro-rework`。在 GitHub 仓库的 Settings → Actions → General 中确认允许执行这些 Actions。
2. 如果 npm 上尚不存在此包，先在本地登录并发布初版：`pnpm login --registry=https://registry.npmjs.org/`，然后 `pnpm publish --access public`。完成账号要求的验证，确保包名可用且你有发布权限；如需换包名，先修改 package.json 和使用说明。npm 的可信发布配置需要包已经存在。
3. 打开 npm 上此包的 Settings → Trusted Publisher，选择 GitHub Actions，填写：

   | 字段 | 值 |
   | --- | --- |
   | Organization or user | `rework-union` |
   | Repository | `taro-rework` |
   | Workflow filename | `publish.yml`（只填文件名） |
   | Environment name | 留空，本工作流没有指定 environment |
   | Allowed actions | 启用 `npm publish`，以允许工作流直接发布 |

4. 保存。新可信发布配置需在 2 天内成功发布一次，超时则删除并重新创建。若仓库迁移，或工作流改名，需要重新配置对应信息。

后续发布以已经手动发布 `0.1.0` 为例：

```sh
# 修改 package.json 的 version 为 0.1.1，并提交本次发布的全部改动。
git add .
git commit -m "Release 0.1.1"
git tag v0.1.1
git push origin HEAD
git push origin v0.1.1
```

在 GitHub 的 Actions → Publish to npm 中查看结果。仅创建 tag 或 GitHub Release 草稿不会触发；将 tag 推送到 GitHub 才会触发。npm 已发布的同一版本不能覆盖，后续发布需要增加版本号。预发布用法相同，例如 package.json 版本设为 `0.2.0-beta.1`，推送 `v0.2.0-beta.1`，用户通过 `pnpm add taro-rework@next` 安装。
