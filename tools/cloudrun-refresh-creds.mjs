// One-off: refresh the running service's TCB_SECRET_* / TCB_TOKEN with the
// operator's current ~/.config/.cloudbase/auth.json STS values. Reads the
// service's existing EnvParams, swaps just those three fields, and submits.
//
// STS creds expire in ~2h; this is the manual workaround until creation pulls
// long-lived service-account creds. Pair with cloudrun-fix-store.mjs (which
// removes OAK_USE_MEMORY_STORE) when migrating an in-memory deploy onto DB.

import { readFileSync } from "fs";
import { resolve } from "path";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);
const { sign } = _require("@cloudbase/signature-nodejs");
const home = process.env.HOME;
const c = JSON.parse(readFileSync(resolve(home, ".config/.cloudbase/auth.json"), "utf-8")).credential;

if (!c.tmpSecretId || !c.tmpSecretKey) {
  throw new Error("No tmpSecretId/tmpSecretKey in auth.json — run `tcb login` first.");
}

async function callTcbr(action, payload) {
  const host = "tcbr.tencentcloudapi.com";
  const url = `https://${host}/`;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    Host: host,
    "X-TC-Action": action,
    "X-TC-Version": "2022-02-17",
    "X-TC-Region": "ap-shanghai",
    ...(c.tmpToken ? { "X-TC-Token": c.tmpToken } : {}),
  };
  const ts = Math.floor(Date.now() / 1000) - 1;
  const { authorization } = sign({
    secretId: c.tmpSecretId, secretKey: c.tmpSecretKey,
    method: "POST", url, headers, params: payload, timestamp: ts,
    withSignedParams: false, isCloudApi: true, service: "tcbr",
  });
  headers["Authorization"] = authorization;
  headers["X-TC-Timestamp"] = String(ts);
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (body?.Response?.Error) throw new Error(`${action} ${body.Response.Error.Code}: ${body.Response.Error.Message}`);
  return body?.Response ?? body;
}

const envId = process.argv[2] || "test-6g2rfs50c69b7fb8";
const serviceName = process.argv[3] || "stop-resume-demo-xpd271";

console.log(`Reading current env for ${serviceName}...`);
const detail = await callTcbr("DescribeCloudRunServerDetail", { EnvId: envId, ServerName: serviceName });
const ep = detail?.ServerConfig?.EnvParams;
if (typeof ep !== "string") throw new Error(`unexpected EnvParams type: ${typeof ep}`);
const envMap = JSON.parse(ep);

const oldKeyLen = envMap.TCB_SECRET_KEY?.length ?? 0;
const oldTokLen = envMap.TCB_TOKEN?.length ?? 0;

envMap.TCB_SECRET_ID = c.tmpSecretId;
envMap.TCB_SECRET_KEY = c.tmpSecretKey;
if (c.tmpToken) envMap.TCB_TOKEN = c.tmpToken;
else delete envMap.TCB_TOKEN;

console.log(`Refreshing TCB_SECRET_*: keyLen ${oldKeyLen}→${envMap.TCB_SECRET_KEY.length}, tokLen ${oldTokLen}→${envMap.TCB_TOKEN?.length ?? 0}`);
console.log("Submitting...");
const r = await callTcbr("SubmitServerConfigChangeDiff", {
  EnvId: envId,
  ServerName: serviceName,
  Items: [{ Key: "EnvParam", Value: JSON.stringify(envMap) }],
});
console.log(`TaskId: ${r?.TaskId ?? "(no TaskId)"}`);
console.log("Done. Wait ~60-90s for the rollout, then test.");
console.log("Note: these STS creds also expire in ~2h. Re-run after each `tcb login`.");
