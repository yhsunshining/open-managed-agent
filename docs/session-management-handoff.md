# Session 管理交接文档

**状态**(2026-06-03 最终):**ACP runtime 侧已全部修复并部署验证 ✅**。
本仓库这边的 bug 全清,但有 **2 个 kernel 上游 bug** 我们只能在 ACP runtime 层兜底,
真正的修法需要在 `coding-agent-template/packages/open-agent-kernel` 提交并发新版 tarball。

vendor tarball(`packages/agent-runtime/vendor/cloudbase-open-agent-kernel-0.1.0-alpha.0.tgz`)
**未被本地修改过** —— 与上游 `feat/acp-chat-playground` 分支的 `src/session-store/` 文件
逐字节相同,只有 `src/public/create-agent.ts` 因为上游加了 PR #7.1 的 client-side tool 流而
不一致(那部分跟 session 管理无关)。所以**没必要**重新打包 tarball;直接对上游 src/ 改后
让 kernel 团队走正常发版流程即可。

## TL;DR

我们对外的现象是 `magent session:list` 拿不到刚创建的空 session。链路上踩到 4 个 bug:

| # | 位置 | 状态 |
|---|---|---|
| 1 | `magent.mjs` session 命令打的是不存在的 `localhost:3000` REST | ✅ 已修(本仓库) |
| 2 | `magent.mjs` `agent:delete` 不级联删 session,oak_* 留孤儿 | ✅ 已修(本仓库) |
| 3 | **kernel `createSession` 的 `registerSession.catch()` 是 fire-and-forget,SCF/cloudrun 实例回收前可能没写完** | 🟡 ACP runtime 层兜底,**上游待修** |
| 4 | **kernel `InMemoryDriver` 的 `registerSession` 与 `listSessions` 写读两个独立 Map,内存模式下 list 永远看不到 register 的 session** | 🟡 我们绕开了(强制 DB 模式),**上游待修** |

外加一个**配置侧 bug**(已修):

| # | 位置 | 状态 |
|---|---|---|
| 5 | `magent.mjs:buildCloudRunEnvParam` 用 shell `process.env.TCB_SECRET_*` 判断 hasDbCreds,但 STS 凭据是后面才从 `tcb login` 拉出来注入 envMap 的 → `OAK_USE_MEMORY_STORE=1` 被错误地永久注入,即使容器有有效 DB 凭据 | ✅ 已修 |

## ACP runtime 侧的最终修复(本仓库)

### `packages/agent-runtime/src/kernel-adapter.ts`

新增 `_sessionStore` 单例(在 `getKernelAgent()` 时从 `kernelConfig.session.store` 捕获),
新增 `syncRegisterSession(sessionId, userId)`:

```ts
export async function syncRegisterSession(sessionId, userId): Promise<boolean> {
  const ts = Date.now();
  if (!_sessionStore?.registerSession) {
    _lastSyncRegister = { sessionId, ok: false, error: "skipped", ts };
    return false;
  }
  try {
    await _sessionStore.registerSession({ projectKey: "", sessionId, userId });
    _lastSyncRegister = { sessionId, ok: true, ts };
    return true;
  } catch (err) {
    _lastSyncRegister = { sessionId, ok: false, error: err.message, ts };
    throw err;
  }
}
```

`projectKey: ""` 是有意的 —— `CloudBaseSessionStore.mapProjectKey()` 在构造时
设了 `fixedProjectKey: envId`,会无视传入值,改用固定的 envId。

新增 `getStoreDiag()` 把 `agentInitialized / storeCaptured / hasRegisterSession /
storeProto / lastSyncRegister` 暴露给 `/healthz`,方便部署后探测修复是否生效。

### `packages/agent-runtime/src/acp-endpoint.ts`

`handleSessionNew()` 的两条路径(传 id / 不传 id)都在 kernel 创建之后 `await syncRegisterSession(...)`:

```ts
// 不传 id 路径
const session = await agent.startSession({ userId });
registerKernelSession(session.id, session);
await syncRegisterSession(session.id, userId);   // ← 兜底

// 传 id 路径
await getOrCreateKernelSession(config, reqSessionId, { userId, isNew: true });
await syncRegisterSession(reqSessionId, userId); // ← 兜底
```

`handleSessionList()` 加了 dedup —— 因为 kernel fire-and-forget + 我们的 sync 调用并发,
DB 偶尔有同 sid 双行(driver 的 existence check 不原子)。Map 按 conversationId 折叠,
取 min(createdAt) / max(updatedAt):

```ts
const dedupedMap = new Map<string, typeof summaries[number]>();
for (const s of summaries) {
  const prev = dedupedMap.get(s.conversationId);
  if (!prev) dedupedMap.set(s.conversationId, s);
  else dedupedMap.set(s.conversationId, {
    ...prev,
    createdAt: Math.min(prev.createdAt ?? Infinity, s.createdAt ?? Infinity),
    updatedAt: Math.max(prev.updatedAt ?? 0, s.updatedAt ?? 0),
  });
}
```

### `packages/agent-runtime/src/index.ts`

启动时 eager call `getKernelAgent(config)`(让 `/healthz` 第一次探测就能反映真实 store 状态),
`/healthz` 返回 `buildMarker: "syncRegisterSession-v3"` + `getStoreDiag()`。

bumpMarker 每次发版 +1,客户端打 `/healthz` 就能确认是否拿到了新版本。

### `magent.mjs`

- 4 个 `session:*` 命令(`create / list / get / delete`)从 broken `localhost:3000` REST 切到 ACP JSON-RPC,要求 `-a/-e`
- `agent:delete` Phase 1.5:删 agent 注册前先 `session/list` + 逐条 `session/delete` 级联
- `printAcpSession()`:正确处理毫秒时间戳(driver 用 `Date.now()`)
- `buildCloudRunEnvParam()`:把 STS 凭据先注入 envMap,再用 `envMap.TCB_SECRET_*` 判断 hasDbCreds —— 不再因为操作员 shell 没有 `TCB_SECRET_*` 就错误注入 `OAK_USE_MEMORY_STORE=1`

### 新增的运维脚本

`tools/cloudrun-fix-store.mjs <envId> <serviceName>` — 一键删除现有 cloudrun service 的 `OAK_USE_MEMORY_STORE=1`,把已经在生产的 agent 从内存模式迁到 DB 模式。

`tools/cloudrun-refresh-creds.mjs <envId> <serviceName>` — 一键把当前 `tcb login` 的 STS 推到 cloudrun service。STS 2 小时失效后用这个续命。

---

## 上游 kernel 待修(`/Users/yang/git/coding-agent-template/packages/open-agent-kernel`)

> 分支:`feat/acp-chat-playground`,本地 ahead of `origin` 6 commits。
> 改完别忘了 `npm pack` 重新生成 tarball,然后替换本仓库的
> `packages/agent-runtime/vendor/cloudbase-open-agent-kernel-0.1.0-alpha.0.tgz`(同时 bump 版本号)。

### Bug A: `registerSession` 是 fire-and-forget(高优先级)

**位置:** `src/public/create-agent.ts:382-397`

**当前代码:**

```ts
if (typeof storeWithRegister.registerSession === 'function') {
  const projectKey = config.session?.projectKey ?? config.envId
  storeWithRegister
    .registerSession({
      projectKey,
      sessionId: conversationId,
      userId,
    })
    .catch(() => {
      // 注册失败不阻塞 session 创建
      if (process.env.OAK_DEBUG === '1') {
        // eslint-disable-next-line no-console
        console.error('[oak] registerSession failed (non-blocking)')
      }
    })
}
```

**问题:**
1. 没 await。SCF / cloudrun(`MinNum=0` 缩到 0)在请求返回后立即可能 SIGKILL 容器,
   未刷盘的 fetch 直接死掉。client 拿到 sessionId 但 DB 里啥都没有。
2. session/list 走 `agent.sessions.list()` → `store.listSessions()` 读的是 DB 里
   `oak_sessions` 表(对 InMemoryDriver 也是 `this.sessions` Map),没写就看不到。
3. 我们从 ACP runtime 兜底了(`syncRegisterSession` await),但 kernel 自身的
   contract 仍然是"返回成功 = 写盘成功",对其它 kernel 用户(直接 `createAgent`
   不经 ACP 的)依然踩坑。

**最小修法:**

```ts
if (typeof storeWithRegister.registerSession === 'function') {
  const projectKey = config.session?.projectKey ?? config.envId
  try {
    await storeWithRegister.registerSession({
      projectKey,
      sessionId: conversationId,
      userId,
    })
  } catch (err) {
    if (process.env.OAK_DEBUG === '1') {
      console.error('[oak] registerSession failed:', err)
    }
    throw err  // 让调用方决定 — 静默吞错只对极少数场景合适
  }
}
```

如果担心向后兼容(有些用户依赖"registerSession 失败也能拿到 session"的行为),
更稳妥的做法是新增一个 opt-in 配置:

```ts
// AgentConfig.session
{
  store,
  projectKey,
  awaitRegister?: boolean   // 默认 true,旧行为可显式 false 退回
}
```

我们的 ACP runtime 不需要这个 opt-in —— 我们想要 fail-fast。

### Bug B: `InMemoryDriver` 的 `registerSession` / `listSessions` 写读不一致

**位置:** `src/session-store/drivers/in-memory-driver.ts:108-121`(register)+ `:95-106`(list)

**当前代码:**

```ts
// :95-106
async listSessions(projectKey: string) {
  const result = []
  for (const record of this.sessions.values()) {        // ← 读 sessions Map
    if (record.projectKey === projectKey && record.subpath === undefined) {
      const sk = `${record.projectKey}|${record.sessionId}`
      const meta = this.sessionMeta.get(sk)
      result.push({ sessionId: record.sessionId, mtime: record.mtime, userId: meta?.userId })
    }
  }
  return result
}

// :108-121
async registerSession(args) {
  const sk = `${args.projectKey}|${args.sessionId}`
  this.sessionMeta.set(sk, { ... })                     // ← 只写 sessionMeta Map
}
```

`this.sessions`(`:39`)只在 `appendEntries`(`:50-76`)里 populate。
`this.sessionMeta`(`:45-48`)只在 `registerSession` 里 populate。
两个 Map 互不通信,**`registerSession` 写完之后 `listSessions` 永远看不到。**

这跟 `CloudBaseDbDriver` 的语义不一致 —— DB 版的 `registerSession` 直接 add 到
`oak_sessions` 表(`:334-344`),`listSessions` 也读同一张表(`:302-313`),写后立即可见。

**最小修法:**

`registerSession` 同时占位写入 `this.sessions`(只占位,entries 为空、mtime=now):

```ts
async registerSession(args: {
  projectKey: string
  sessionId: string
  userId: string
  title?: string
  metadata?: Record<string, unknown>
}): Promise<void> {
  const sk = `${args.projectKey}|${args.sessionId}`
  this.sessionMeta.set(sk, {
    userId: args.userId,
    title: args.title,
    metadata: args.metadata,
  })
  // 占位写入主索引,使 listSessions 能立刻看到。后续 appendEntries 会 update mtime
  // 并填充 entries(SessionRecord 的 uuidSet/entries 字段),与 CloudBaseDbDriver
  // 的语义对齐(register → 出现在 list ; append → mtime 推进)。
  if (!this.sessions.has(sk)) {
    this.sessions.set(sk, {
      projectKey: args.projectKey,
      sessionId: args.sessionId,
      subpath: undefined,
      entries: [],
      uuidSet: new Set(),
      mtime: Date.now(),
    })
  }
}
```

### Bug C(锦上添花): driver 层 `registerSession` 在并发下会写双行

**位置:** `src/session-store/drivers/cloudbase-db-driver.ts:315-345`

**问题:**

```ts
async registerSession(args) {
  const sessionsCol = await this.getCollection('sessions')
  const existing = await sessionsCol.where({...}).limit(1).get()  // ← (A)
  if (existing.data && existing.data.length > 0) {
    await sessionsCol.where({...}).update({...})
  } else {
    await sessionsCol.add({...})                                   // ← (B)
  }
}
```

A 和 B 不是事务。Kernel 的 fire-and-forget call 和我们 ACP runtime 的
`syncRegisterSession` 在 ~1ms 内并发触发两次 `registerSession`,两次 (A) 都
miss,两次 (B) 都 add → DB 出现两行同 sessionId。

(线上观察:刚 deploy 完,`oak_sessions` 里有 2 行 `7e438746-...`,createdAt
相差 1ms。)

我们目前在 ACP runtime 的 `handleSessionList()` 里按 conversationId dedup
绕开了显示问题,但 DB 实际还是双行。一旦上游修了 Bug A(fire-and-forget →
await),kernel 内部就只调一次 registerSession,我们的 syncRegisterSession
仍然会再调一次,**仍然有这个竞态**。

**最小修法:** 用 sessionKey 唯一索引 + try/catch unique-violation,把竞态
控制下沉到 DB:

```ts
async registerSession(args) {
  const sessionsCol = await this.getCollection('sessions')
  const now = Date.now()
  try {
    await sessionsCol.add({
      sessionKey: `${args.projectKey}|${args.sessionId}`,
      projectKey: args.projectKey,
      sessionId: args.sessionId,
      userId: args.userId,
      title: args.title ?? null,
      metadata: args.metadata ?? null,
      mtime: now,
      createdAt: now,
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      // 已存在,update mtime/userId(允许 register 更新元数据)
      await sessionsCol.where({
        projectKey: args.projectKey,
        sessionId: args.sessionId,
      }).update({
        userId: args.userId,
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
        mtime: now,
      })
    } else {
      throw err
    }
  }
}
```

要求 `oak_sessions` 在 `sessionKey`(或 `projectKey + sessionId` 复合)上有
unique index。如果当前 schema 没建,需要在 `getCollection('sessions')` 里
加一次 `createIndex`。

如果 cloudbase NoSQL 不支持 unique violation 检测,降级方案是用
`update` 的"找不到才 add"模式(先 update,returnedRowCount === 0 才 add) ——
但 `updateMany` 然后 read result 再 add 仍然不是原子的,只是窗口比 (A)+(B)
小一些。

---

## 部署后验证清单(让接手人能复现整个测试)

### 1. 先确认本仓库代码已 build 并部署

```bash
cd /Users/yang/git/open-managed-agent
cd packages/agent-runtime && npx tsc && cd -
node --check magent.mjs
```

### 2. 找到目标 agent 和 cloudrun service

```bash
node magent.mjs agent:list -e <envId>
# 用对应 ServiceId(Type=TCBR 云托管) 查 cloudrun service:
node $(node -e "console.log(require.resolve('@cloudbase/cli/dist/standalone/cli.js'))") \
     cloudrun list -e <envId>
```

### 3. 确认 `OAK_USE_MEMORY_STORE` 没被错误注入

```bash
# 看当前 EnvParams(用 cloudrun-fix-store 顺便就 print 出来)
node tools/cloudrun-fix-store.mjs <envId> <serviceName>
# 如果显示 OAK_USE_MEMORY_STORE = 1,这个脚本会顺便删掉它。
# 如果显示 (unset),就 ctrl-c 掉,啥也不用做。
```

### 4. 确保有有效 STS 凭据

```bash
node tools/cloudrun-refresh-creds.mjs <envId> <serviceName>
# STS 来自 ~/.config/.cloudbase/auth.json,2h 失效。每次 `tcb login` 后跑一次。
```

### 5. 重新部署 runtime

```bash
DEPLOY=/tmp/redeploy-$(date +%s)
mkdir -p "$DEPLOY"
cp -r packages/agent-runtime/{Dockerfile,.dockerignore,package.json,dist,vendor,scf_bootstrap,agent.yaml*} "$DEPLOY/" 2>/dev/null || true
cp -r packages/agent-runtime/package-lock.json "$DEPLOY/" 2>/dev/null || true
cat > "$DEPLOY/cloudbaserc.json" <<EOF
{ "version": "2.0", "envId": "<envId>" }
EOF

printf "\n\n" | node $(node -e "console.log(require.resolve('@cloudbase/cli/dist/standalone/cli.js'))") \
  cloudrun deploy -e <envId> -s <serviceName> --source "$DEPLOY" --force
# 等 ~5-7 分钟,或用 node tools/cloudrun-logs.mjs <serviceName> 轮询 DeployRecords
```

### 6. 验证修复

```bash
# /healthz 探测(用 cloudrun 的 default domain,不是 ACP gateway)
curl -s https://<serviceName>-<region>.run.tcloudbase.com/healthz
# 应该看到:
#   buildMarker: "syncRegisterSession-v3" 或更新
#   store: { agentInitialized: true, storeCaptured: true,
#            hasRegisterSession: true, storeProto: "CloudBaseSessionStore" }

# 创建空 session
node magent.mjs session:create -a <agentId> -e <envId> --title "smoke"

# 立即 list,应该看到刚创建的(不需要先发消息)
node magent.mjs session:list -a <agentId> -e <envId>

# /healthz lastSyncRegister 应该填上了 ok=true
curl -s https://<serviceName>-<region>.run.tcloudbase.com/healthz | python3 -m json.tool
```

### 7. 直查数据库确认双行情况(可选)

```bash
# 用 mcp__cloudbase__queryDocuments 或直接 cloudbase NoSQL console
# 查 oak_sessions 集合,where sessionId == <new sid>
# 修复前:0 行(empty session 不会出现)
# 当前修复后:可能是 2 行(kernel + sync 双写竞态),由 list-side dedup 兜住
# Bug C 修了之后:1 行
```

## 历史记录(供 git blame 用)

- 修复提交在 `magent.mjs` + `packages/agent-runtime/src/{kernel-adapter,acp-endpoint,index}.ts`
- 在线测试 agent:`agent-stop-resume-demo-9c2611949`
- cloudrun service:`stop-resume-demo-xpd271`
- 部署版本演进:001 (旧) → 002 (v1 fix) → 003 (v2 加诊断) → 004/005 (env 切换) → 006 (v3 + dedup + 清调试日志)
- 最终 buildMarker:`syncRegisterSession-v3`

## Open Questions

1. **`AgentConfig.session.store` 的类型故意是 `unknown`** —— kernel 不想把 SDK 类型暴露到 public surface(`packages/open-agent-kernel/src/public/types.ts:445`)。我们在 `kernel-adapter.ts` 里再 narrow 成 `SessionStoreLike`(只声明用到的 `registerSession?`),并不能拿到完整接口。Bug B 修完之后这个 narrow 仍然是 OK 的。
2. **kernel 的 `awaitRegister` opt-in 需不需要做?** 看 kernel 团队是否在乎"registerSession 失败也要返回 session"的旧行为。如果没人依赖,就直接改成 await + throw,简单。
