// One-off: flip the running service to use the CloudBase DB store by removing
// OAK_USE_MEMORY_STORE from its EnvParams. Reads current env, mutates, pushes
// via SubmitServerConfigChangeDiff (same path as `magent agent:update`).

import { readFileSync } from "fs";
import { resolve } from "path";
import { createRequire } from "module";

const _require = createRequire(import.meta.url);
const { sign } = _require("@cloudbase/signature-nodejs");
const home = process.env.HOME;
const c = JSON.parse(readFileSync(resolve(home, ".config/.cloudbase/auth.json"), "utf-8")).credential;

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
if (typeof ep !== "string") {
  throw new Error(`unexpected EnvParams type: ${typeof ep}`);
}
const envMap = JSON.parse(ep);
console.log("Current relevant flags:");
console.log(`  OAK_USE_MEMORY_STORE = ${envMap.OAK_USE_MEMORY_STORE ?? "(unset)"}`);
console.log(`  TCB_SECRET_ID        = ${envMap.TCB_SECRET_ID ? `<${envMap.TCB_SECRET_ID.length} chars>` : "(unset)"}`);
console.log(`  TCB_SECRET_KEY       = ${envMap.TCB_SECRET_KEY ? `<${envMap.TCB_SECRET_KEY.length} chars>` : "(unset)"}`);

if (!envMap.TCB_SECRET_ID || !envMap.TCB_SECRET_KEY) {
  console.warn("⚠️  no DB creds found — flipping to DB store will likely crash with MISSING_CREDENTIALS.");
  console.warn("    Provide TCB_SECRET_ID / TCB_SECRET_KEY from a long-lived service account, or stay on memory store.");
}

// Remove memory-store flag.
delete envMap.OAK_USE_MEMORY_STORE;
console.log("\nSubmitting change (removing OAK_USE_MEMORY_STORE)...");
const r = await callTcbr("SubmitServerConfigChangeDiff", {
  EnvId: envId,
  ServerName: serviceName,
  Items: [{ Key: "EnvParam", Value: JSON.stringify(envMap) }],
});
console.log(`TaskId: ${r?.TaskId ?? "(no TaskId)"}`);
console.log("Done. Wait ~60-90s for the rollout, then probe /healthz.");
