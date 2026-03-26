import { useCallback, useEffect, useState } from "react";
import {
  apiClient,
  clearToken,
  getToken,
  setToken,
  type FeishuTarget,
  type Keyword,
  type WeChatSettings,
  type WeChatSubscriber,
} from "./api";

function useAuthedApi() {
  const [ready, setReady] = useState(!!getToken());
  const login = (t: string) => { setToken(t); setReady(true); };
  const logout = () => { clearToken(); setReady(false); };
  return { ready, login, logout };
}

function parseKeywordText(raw: string): string[] {
  const dedup = new Map<string, string>();
  for (const item of raw.split(/[\n,]/)) {
    const phrase = item.trim();
    if (!phrase) continue;
    const key = phrase.toLowerCase();
    if (!dedup.has(key)) dedup.set(key, phrase);
  }
  return Array.from(dedup.values());
}

async function resolveKeywordIdsFromText(raw: string): Promise<number[]> {
  const phrases = parseKeywordText(raw);
  if (!phrases.length) return [];

  let keywords = await apiClient.get<Keyword[]>("/api/keywords");
  let byLower = new Map(keywords.map((k) => [k.phrase.toLowerCase(), k]));

  for (const phrase of phrases) {
    if (byLower.has(phrase.toLowerCase())) continue;
    try {
      await apiClient.post("/api/keywords", { phrase });
    } catch (e) {
      const message = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
      if (!message.includes("exists")) throw e;
    }
  }

  keywords = await apiClient.get<Keyword[]>("/api/keywords");
  byLower = new Map(keywords.map((k) => [k.phrase.toLowerCase(), k]));
  return phrases.map((p) => byLower.get(p.toLowerCase())?.id).filter((id): id is number => Number.isInteger(id));
}

export default function App() {
  const { ready, login, logout } = useAuthedApi();
  const [tokenInput, setTokenInput] = useState("");

  if (!ready) {
    return (
      <div className="login-box">
        <h1>arXiv Digest</h1>
        <p>Enter admin token to continue</p>
        <input
          className="input"
          type="password"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="Admin token"
          style={{ marginBottom: 14, textAlign: "center" }}
        />
        <button className="btn btn-primary" onClick={() => login(tokenInput)} disabled={!tokenInput.trim()} style={{ width: "100%" }}>
          Sign in
        </button>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="app-header">
        <div>
          <h1>arXiv Digest</h1>
          <p>Daily keyword-matched papers from arXiv, pushed to Feishu / WeChat</p>
        </div>
        <button className="btn btn-sm" style={{ background: "rgba(255,255,255,.15)", color: "#fff", border: "none" }} onClick={logout}>
          Log out
        </button>
      </div>
      <Dashboard />
    </div>
  );
}

function Dashboard() {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const flash = useCallback((m: string) => { setMsg(m); setErr(null); setTimeout(() => setMsg(null), 4000); }, []);
  const flashErr = useCallback((e: unknown) => { setErr(e instanceof Error ? e.message : String(e)); setMsg(null); }, []);

  return (
    <>
      {msg && <div className="flash-ok">{msg}</div>}
      {err && <div className="flash-err">{err}</div>}

      <div className="card">
        <h2>Digest actions</h2>
        <DigestActions onOk={flash} onErr={flashErr} />
      </div>

      <div className="card">
        <h2>Feishu targets</h2>
        <FeishuPanel onOk={flash} onErr={flashErr} />
      </div>

      <div className="card">
        <h2>WeChat Official Account</h2>
        <WeChatPanel onOk={flash} onErr={flashErr} />
      </div>
    </>
  );
}

/* ─── Digest ─── */

function DigestActions({ onOk, onErr }: { onOk: (s: string) => void; onErr: (e: unknown) => void }) {
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [runResult, setRunResult] = useState<Record<string, unknown> | null>(null);

  const call = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { onErr(e); } };

  return (
    <div>
      <div className="btn-row">
        <button className="btn" onClick={() => call(async () => { const p = await apiClient.get<Record<string, unknown>>("/api/digest/preview"); setPreview(p); onOk("Preview loaded"); })}>
          Preview papers
        </button>
        <button className="btn" onClick={() => call(async () => { const r = await apiClient.post<Record<string, unknown>>("/api/digest/run", { dry_run: true, force: false }); setRunResult(r); onOk("Dry run complete"); })}>
          Dry run
        </button>
        <button className="btn btn-primary" onClick={async () => { if (!confirm("Send digest to all enabled targets now?")) return; call(async () => { const r = await apiClient.post<Record<string, unknown>>("/api/digest/run", { dry_run: false, force: false }); setRunResult(r); onOk("Digest sent"); }); }}>
          Send digest now
        </button>
        <button className="btn btn-danger" onClick={async () => { if (!confirm("Force re-send even if already sent today?")) return; call(async () => { const r = await apiClient.post<Record<string, unknown>>("/api/digest/run", { dry_run: false, force: true }); setRunResult(r); onOk("Force re-send done"); }); }}>
          Force re-send
        </button>
      </div>
      {preview && <pre className="result-box">{JSON.stringify(preview, null, 2)}</pre>}
      {runResult && <pre className="result-box">{JSON.stringify(runResult, null, 2)}</pre>}
    </div>
  );
}

/* ─── Feishu ─── */

function FeishuPanel({ onOk, onErr }: { onOk: (s: string) => void; onErr: (e: unknown) => void }) {
  const [allKeywords, setAllKeywords] = useState<Keyword[]>([]);
  const [targets, setTargets] = useState<FeishuTarget[]>([]);

  const [name, setName] = useState("");
  const [userLabel, setUserLabel] = useState("");
  const [url, setUrl] = useState("");
  const [keywordText, setKeywordText] = useState("");

  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editUserLabel, setEditUserLabel] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editKeywordText, setEditKeywordText] = useState("");
  const [editEnabled, setEditEnabled] = useState(true);
  const [editRangeMode, setEditRangeMode] = useState<"default" | "custom">("default");
  const [editStartDate, setEditStartDate] = useState("");
  const [editEndDate, setEditEndDate] = useState("");

  const load = useCallback(async () => {
    try {
      const [k, t] = await Promise.all([
        apiClient.get<Keyword[]>("/api/keywords"),
        apiClient.get<FeishuTarget[]>("/api/feishu-targets"),
      ]);
      setAllKeywords(k);
      setTargets(t);
    } catch (e) { onErr(e); }
  }, [onErr]);

  useEffect(() => { load(); }, [load]);

  const kwNames = (ids: number[]) => ids.map((id) => allKeywords.find((k) => k.id === id)?.phrase).filter(Boolean);

  const startEdit = (t: FeishuTarget) => {
    setEditId(t.id);
    setEditName(t.name);
    setEditUserLabel(t.target_user_label || "");
    setEditUrl(t.webhook_url);
    setEditKeywordText(kwNames(t.keyword_ids).join(", "));
    setEditEnabled(t.enabled);
    const hasRange = !!(t.target_preview_start_date && t.target_preview_end_date);
    setEditRangeMode(hasRange ? "custom" : "default");
    setEditStartDate(t.target_preview_start_date || "");
    setEditEndDate(t.target_preview_end_date || "");
  };

  const saveEdit = async (id: number) => {
    try {
      if (editRangeMode === "custom" && (!editStartDate || !editEndDate)) {
        onErr("Custom range requires both start and end dates.");
        return;
      }
      const keywordIds = await resolveKeywordIdsFromText(editKeywordText);
      await apiClient.patch(`/api/feishu-targets/${id}`, {
        name: editName,
        target_user_label: editUserLabel,
        target_preview_start_date: editRangeMode === "default" ? "" : editStartDate,
        target_preview_end_date: editRangeMode === "default" ? "" : editEndDate,
        webhook_url: editUrl,
        enabled: editEnabled,
        keyword_ids: keywordIds,
      });
      setEditId(null);
      await load();
      onOk("Target updated");
    } catch (e) { onErr(e); }
  };

  return (
    <div>
      {/* ── Add new ── */}
      <h3>Add target</h3>
      <div className="form-grid">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name" />
        <input className="input" value={userLabel} onChange={(e) => setUserLabel(e.target.value)} placeholder="User label (optional)" />
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Webhook URL (https://...)" />
        <textarea className="input textarea" value={keywordText} onChange={(e) => setKeywordText(e.target.value)} rows={2} placeholder="Keywords for this target (comma separated, e.g. transformer, diffusion)" />
        <div className="form-hint">Each target gets its own keyword set. Papers matching any keyword are included.</div>
        <button
          className="btn btn-primary"
          disabled={!name.trim() || !url.startsWith("https://")}
          onClick={async () => {
            try {
              const keywordIds = await resolveKeywordIdsFromText(keywordText);
              await apiClient.post<FeishuTarget>("/api/feishu-targets", {
                name, target_user_label: userLabel, webhook_url: url, enabled: true, keyword_ids: keywordIds,
              });
              setName(""); setUserLabel(""); setUrl(""); setKeywordText("");
              await load();
              onOk("Target added");
            } catch (e) { onErr(e); }
          }}
        >
          Add target
        </button>
      </div>

      {/* ── Existing targets ── */}
      {targets.length > 0 && <h3>Targets</h3>}
      {targets.map((t) => (
        <div className="target-item" key={t.id}>
          {editId === t.id ? (
            /* ── Edit mode ── */
            <div className="form-grid">
              <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Group name" />
              <input className="input" value={editUserLabel} onChange={(e) => setEditUserLabel(e.target.value)} placeholder="User label (optional)" />
              <input className="input" value={editUrl} onChange={(e) => setEditUrl(e.target.value)} placeholder="Webhook URL (https://...)" />
              <textarea className="input textarea" value={editKeywordText} onChange={(e) => setEditKeywordText(e.target.value)} rows={2} placeholder="Keywords (comma separated)" />
              <div className="form-row">
                <label style={{ fontSize: 13 }}>
                  <input type="radio" name={`rm-${t.id}`} checked={editRangeMode === "default"} onChange={() => setEditRangeMode("default")} /> Default (yesterday)
                </label>
                <label style={{ fontSize: 13 }}>
                  <input type="radio" name={`rm-${t.id}`} checked={editRangeMode === "custom"} onChange={() => setEditRangeMode("custom")} /> Custom range
                </label>
              </div>
              {editRangeMode === "custom" && (
                <div className="form-row">
                  <input type="date" className="input" value={editStartDate} onChange={(e) => setEditStartDate(e.target.value)} style={{ maxWidth: 170 }} />
                  <span style={{ color: "#94a3b8" }}>to</span>
                  <input type="date" className="input" value={editEndDate} onChange={(e) => setEditEndDate(e.target.value)} style={{ maxWidth: 170 }} />
                </div>
              )}
              <label style={{ fontSize: 13 }}>
                <input type="checkbox" checked={editEnabled} onChange={(e) => setEditEnabled(e.target.checked)} /> Enabled
              </label>
              <div className="btn-row">
                <button className="btn btn-primary" onClick={() => saveEdit(t.id)}>Save</button>
                <button className="btn" onClick={() => setEditId(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            /* ── View mode ── */
            <>
              <div className="target-item-header">
                <strong>{t.name}</strong>
                {t.enabled ? <span className="badge-on">ON</span> : <span className="badge-off">OFF</span>}
                {t.target_user_label && <span style={{ fontSize: 12, color: "#64748b" }}>({t.target_user_label})</span>}
              </div>
              <div className="target-meta">{t.webhook_url}</div>
              {t.keyword_ids.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {kwNames(t.keyword_ids).map((kw) => <span className="tag" key={kw}>{kw}</span>)}
                </div>
              )}
              {!t.keyword_ids.length && <div className="form-hint" style={{ marginTop: 4 }}>No keywords — uses all global keywords</div>}
              {t.target_preview_start_date && t.target_preview_end_date && (
                <div className="form-hint" style={{ marginTop: 4 }}>
                  Preview range: {t.target_preview_start_date} to {t.target_preview_end_date}
                </div>
              )}
              <div className="btn-row">
                <button className="btn btn-sm" onClick={() => startEdit(t)}>Edit</button>
                <button className="btn btn-sm" onClick={async () => { try { await apiClient.post(`/api/feishu-targets/${t.id}/test`, {}); onOk("Test sent"); } catch (e) { onErr(e); } }}>
                  Test webhook
                </button>
                <button className="btn btn-sm btn-success" onClick={async () => {
                  try {
                    const res = await apiClient.post<Record<string, unknown>>(`/api/feishu-targets/${t.id}/sample-digest`, {});
                    onOk(`Preview sent (matched: ${res.matched_papers ?? 0})`);
                  } catch (e) { onErr(e); }
                }}>
                  Send preview
                </button>
                <button className="btn btn-sm" onClick={async () => { try { await apiClient.patch(`/api/feishu-targets/${t.id}`, { enabled: !t.enabled }); await load(); onOk(t.enabled ? "Disabled" : "Enabled"); } catch (e) { onErr(e); } }}>
                  {t.enabled ? "Disable" : "Enable"}
                </button>
                <button className="btn btn-sm btn-danger" onClick={async () => { if (!confirm("Delete this target?")) return; try { await apiClient.delete(`/api/feishu-targets/${t.id}`); await load(); onOk("Deleted"); } catch (e) { onErr(e); } }}>
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/* ─── WeChat ─── */

function WeChatPanel({ onOk, onErr }: { onOk: (s: string) => void; onErr: (e: unknown) => void }) {
  const [settings, setSettings] = useState<WeChatSettings | null>(null);
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [mapping, setMapping] = useState("");
  const [subs, setSubs] = useState<WeChatSubscriber[]>([]);
  const [allKeywords, setAllKeywords] = useState<Keyword[]>([]);
  const [openid, setOpenid] = useState("");
  const [label, setLabel] = useState("");
  const [subKwText, setSubKwText] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, sub, k] = await Promise.all([
        apiClient.get<WeChatSettings>("/api/wechat-settings"),
        apiClient.get<WeChatSubscriber[]>("/api/wechat-subscribers"),
        apiClient.get<Keyword[]>("/api/keywords"),
      ]);
      setSettings(s); setAppId(s.app_id); setTemplateId(s.template_id); setMapping(s.field_mapping);
      setSubs(sub); setAllKeywords(k);
    } catch (e) { onErr(e); }
  }, [onErr]);

  useEffect(() => { load(); }, [load]);

  const kwNames = (ids: number[]) => ids.map((id) => allKeywords.find((k) => k.id === id)?.phrase).filter(Boolean);

  return (
    <div>
      <h3>Settings</h3>
      <div className="form-grid">
        <input className="input" value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="AppID" />
        <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)}
          placeholder={settings?.has_app_secret ? "New secret (leave empty to keep)" : "App secret"} />
        <input className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)} placeholder="Template ID" />
        <textarea className="input textarea mono" value={mapping} onChange={(e) => setMapping(e.target.value)} rows={2}
          placeholder='{"digest_title":"thing1","digest_body":"thing2","link":"url"}' />
        <button className="btn btn-primary" onClick={async () => {
          try {
            const body: Record<string, string> = { app_id: appId, template_id: templateId, field_mapping: mapping };
            if (secret.trim()) body.app_secret = secret;
            await apiClient.patch("/api/wechat-settings", body);
            setSecret(""); await load(); onOk("Settings saved");
          } catch (e) { onErr(e); }
        }}>
          Save settings
        </button>
      </div>

      <h3>Subscribers</h3>
      <div className="form-grid">
        <div className="form-row">
          <input className="input" value={openid} onChange={(e) => setOpenid(e.target.value)} placeholder="openid" style={{ flex: 2 }} />
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label" style={{ flex: 1 }} />
        </div>
        <textarea className="input textarea" value={subKwText} onChange={(e) => setSubKwText(e.target.value)} rows={2}
          placeholder="Keywords for this subscriber (comma separated)" />
        <button className="btn btn-primary" disabled={!openid.trim()} onClick={async () => {
          try {
            const keywordIds = await resolveKeywordIdsFromText(subKwText);
            await apiClient.post("/api/wechat-subscribers", { openid, label, enabled: true, keyword_ids: keywordIds });
            setOpenid(""); setLabel(""); setSubKwText(""); await load(); onOk("Subscriber added");
          } catch (e) { onErr(e); }
        }}>
          Add subscriber
        </button>
      </div>

      {subs.map((s) => (
        <div className="target-item" key={s.id}>
          <div className="target-item-header">
            <strong className="mono">{s.openid}</strong>
            {s.enabled ? <span className="badge-on">ON</span> : <span className="badge-off">OFF</span>}
            {s.label && <span style={{ fontSize: 12, color: "#64748b" }}>({s.label})</span>}
          </div>
          {s.keyword_ids.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {kwNames(s.keyword_ids).map((kw) => <span className="tag" key={kw}>{kw}</span>)}
            </div>
          )}
          <div className="btn-row">
            <button className="btn btn-sm" onClick={async () => { try { await apiClient.post(`/api/wechat-subscribers/${s.id}/test`, {}); onOk("Test sent"); } catch (e) { onErr(e); } }}>
              Test template
            </button>
            <button className="btn btn-sm" onClick={async () => { try { await apiClient.patch(`/api/wechat-subscribers/${s.id}`, { enabled: !s.enabled }); await load(); onOk(s.enabled ? "Disabled" : "Enabled"); } catch (e) { onErr(e); } }}>
              {s.enabled ? "Disable" : "Enable"}
            </button>
            <button className="btn btn-sm btn-danger" onClick={async () => { if (!confirm("Remove subscriber?")) return; try { await apiClient.delete(`/api/wechat-subscribers/${s.id}`); await load(); onOk("Removed"); } catch (e) { onErr(e); } }}>
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
