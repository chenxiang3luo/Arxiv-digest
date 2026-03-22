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

  const login = (t: string) => {
    setToken(t);
    setReady(true);
  };

  const logout = () => {
    clearToken();
    setReady(false);
  };

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
      <div style={{ maxWidth: 420, margin: "4rem auto", padding: 24 }}>
        <h1>arXiv digest</h1>
        <p>
          Enter the admin token (same as <code>ADMIN_TOKEN</code> in <code>.env</code>). Paste the token only — not
          the word <code>Bearer</code>. You can put <code>.env</code> in the repo root or in <code>backend/</code>.
        </p>
        <input
          type="password"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="Admin token"
          style={{ width: "100%", padding: 10, marginBottom: 12 }}
        />
        <button
          type="button"
          onClick={() => login(tokenInput)}
          disabled={!tokenInput.trim()}
          style={{ padding: "10px 20px" }}
        >
          Save & continue
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>arXiv digest</h1>
        <button type="button" onClick={logout}>
          Log out
        </button>
      </header>
      <p style={{ color: "#64748b" }}>
        Papers: previous calendar day in Asia/Shanghai, keyword-matched. Daily run at 12:00 Beijing via systemd/cron
        calling <code>POST /api/digest/run</code>.
      </p>
      <Dashboard />
    </div>
  );
}

function Dashboard() {
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const flash = useCallback((m: string) => {
    setMsg(m);
    setErr(null);
    setTimeout(() => setMsg(null), 4000);
  }, []);

  const flashErr = useCallback((e: unknown) => {
    setErr(e instanceof Error ? e.message : String(e));
    setMsg(null);
  }, []);

  return (
    <>
      {msg && <div style={{ padding: 12, background: "#dcfce7", marginBottom: 16 }}>{msg}</div>}
      {err && <div style={{ padding: 12, background: "#fee2e2", marginBottom: 16 }}>{err}</div>}

      <section style={{ marginBottom: 16, padding: 14, border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff" }}>
        <h2 style={{ marginTop: 0 }}>Quick start</h2>
        <div style={{ color: "#475569", fontSize: 14 }}>
          1) Add keywords {"->"} 2) Add Feishu target webhook {"->"} 3) Send real API digest preview
        </div>
      </section>

      <section style={{ marginBottom: 20, padding: 16, border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff" }}>
        <h2>Digest</h2>
        <DigestActions onOk={flash} onErr={flashErr} />
      </section>

      <section style={{ marginBottom: 20, padding: 16, border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff" }}>
        <h2>Keywords</h2>
        <KeywordsPanel onOk={flash} onErr={flashErr} />
      </section>

      <section style={{ marginBottom: 20, padding: 16, border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff" }}>
        <h2>Feishu targets</h2>
        <FeishuPanel onOk={flash} onErr={flashErr} />
      </section>

      <section style={{ marginBottom: 20, padding: 16, border: "1px solid #e2e8f0", borderRadius: 10, background: "#fff" }}>
        <h2>WeChat Official Account</h2>
        <WeChatPanel onOk={flash} onErr={flashErr} />
      </section>
    </>
  );
}

function DigestActions({
  onOk,
  onErr,
}: {
  onOk: (s: string) => void;
  onErr: (e: unknown) => void;
}) {
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [runResult, setRunResult] = useState<Record<string, unknown> | null>(null);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={async () => {
            try {
              const p = await apiClient.get<Record<string, unknown>>("/api/digest/preview");
              setPreview(p);
              onOk("Preview loaded");
            } catch (e) {
              onErr(e);
            }
          }}
        >
          Preview papers
        </button>
        <button
          type="button"
          onClick={async () => {
            try {
              const r = await apiClient.post<Record<string, unknown>>("/api/digest/run", {
                dry_run: true,
                force: false,
              });
              setRunResult(r);
              onOk("Dry run complete");
            } catch (e) {
              onErr(e);
            }
          }}
        >
          Dry run (no send)
        </button>
        <button
          type="button"
          onClick={async () => {
            if (!confirm("Run digest now (real sends)?")) return;
            try {
              const r = await apiClient.post<Record<string, unknown>>("/api/digest/run", {
                dry_run: false,
                force: false,
              });
              setRunResult(r);
              onOk("Digest run finished");
            } catch (e) {
              onErr(e);
            }
          }}
        >
          Send digest now
        </button>
        <button
          type="button"
          onClick={async () => {
            if (!confirm("Force re-send even if already sent today?")) return;
            try {
              const r = await apiClient.post<Record<string, unknown>>("/api/digest/run", {
                dry_run: false,
                force: true,
              });
              setRunResult(r);
              onOk("Force digest finished");
            } catch (e) {
              onErr(e);
            }
          }}
        >
          Force re-send
        </button>
      </div>
      {preview && (
        <pre style={{ marginTop: 12, overflow: "auto", background: "#fff", padding: 12, borderRadius: 8 }}>
          {JSON.stringify(preview, null, 2)}
        </pre>
      )}
      {runResult && (
        <pre style={{ marginTop: 12, overflow: "auto", background: "#fff", padding: 12, borderRadius: 8 }}>
          {JSON.stringify(runResult, null, 2)}
        </pre>
      )}
    </div>
  );
}

function KeywordsPanel({
  onOk,
  onErr,
}: {
  onOk: (s: string) => void;
  onErr: (e: unknown) => void;
}) {
  const [list, setList] = useState<Keyword[]>([]);
  const [phrase, setPhrase] = useState("");

  const load = useCallback(async () => {
    try {
      const k = await apiClient.get<Keyword[]>("/api/keywords");
      setList(k);
    } catch (e) {
      onErr(e);
    }
  }, [onErr]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          placeholder="New keyword phrase"
          style={{ flex: 1, padding: 8 }}
        />
        <button
          type="button"
          onClick={async () => {
            try {
              await apiClient.post("/api/keywords", { phrase });
              setPhrase("");
              await load();
              onOk("Keyword added");
            } catch (e) {
              onErr(e);
            }
          }}
          disabled={!phrase.trim()}
        >
          Add
        </button>
      </div>
      <ul style={{ paddingLeft: 20 }}>
        {list.map((k) => (
          <li key={k.id} style={{ marginBottom: 8 }}>
            <code>{k.phrase}</code>{" "}
            <button
              type="button"
              onClick={async () => {
                if (!confirm(`Delete "${k.phrase}"?`)) return;
                try {
                  await apiClient.delete(`/api/keywords/${k.id}`);
                  await load();
                  onOk("Deleted");
                } catch (e) {
                  onErr(e);
                }
              }}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FeishuPanel({
  onOk,
  onErr,
}: {
  onOk: (s: string) => void;
  onErr: (e: unknown) => void;
}) {
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [targets, setTargets] = useState<FeishuTarget[]>([]);
  const [name, setName] = useState("");
  const [targetUserLabel, setTargetUserLabel] = useState("");
  const [url, setUrl] = useState("");
  const [keywordText, setKeywordText] = useState("");
  const [editingTargetId, setEditingTargetId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editTargetUserLabel, setEditTargetUserLabel] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editKeywordText, setEditKeywordText] = useState("");
  const [editEnabled, setEditEnabled] = useState(true);
  const [editPreviewStartDate, setEditPreviewStartDate] = useState("");
  const [editPreviewEndDate, setEditPreviewEndDate] = useState("");
  const [editPreviewUseDefault, setEditPreviewUseDefault] = useState(true);

  const load = useCallback(async () => {
    try {
      const [k, t] = await Promise.all([
        apiClient.get<Keyword[]>("/api/keywords"),
        apiClient.get<FeishuTarget[]>("/api/feishu-targets"),
      ]);
      setKeywords(k);
      setTargets(t);
    } catch (e) {
      onErr(e);
    }
  }, [onErr]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <p style={{ fontSize: 14, color: "#64748b" }}>
        Leave keyword text empty to use <strong>all</strong> global keywords for that target.
      </p>
      <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Label" style={{ padding: 8 }} />
        <input
          value={targetUserLabel}
          onChange={(e) => setTargetUserLabel(e.target.value)}
          placeholder="Target user label (optional)"
          style={{ padding: 8 }}
        />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
          style={{ padding: 8 }}
        />
        <textarea
          value={keywordText}
          onChange={(e) => setKeywordText(e.target.value)}
          rows={3}
          placeholder="Optional keywords. Type comma/newline separated, e.g. transformer, diffusion"
          style={{ width: "100%", padding: 8 }}
        />
        <div style={{ fontSize: 13, color: "#64748b" }}>
          Existing global keywords: {keywords.map((k) => k.phrase).join(", ") || "(none yet)"}
        </div>
        <button
          type="button"
          onClick={async () => {
            try {
              const keywordIds = await resolveKeywordIdsFromText(keywordText);
              await apiClient.post<FeishuTarget>("/api/feishu-targets", {
                name,
                target_user_label: targetUserLabel,
                webhook_url: url,
                enabled: true,
                keyword_ids: keywordIds,
              });
              setName("");
              setTargetUserLabel("");
              setUrl("");
              setKeywordText("");
              await load();
              onOk("Feishu target added");
            } catch (e) {
              onErr(e);
            }
          }}
          disabled={!name.trim() || !url.startsWith("https://")}
        >
          Add target
        </button>
      </div>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {targets.map((t) => (
          <li
            key={t.id}
            style={{
              border: "1px solid #e2e8f0",
              borderRadius: 8,
              padding: 12,
              marginBottom: 12,
              background: "#fff",
            }}
          >
            {editingTargetId === t.id ? (
              <div style={{ display: "grid", gap: 8 }}>
                <input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="Target label"
                  style={{ padding: 8 }}
                />
                <input
                  value={editTargetUserLabel}
                  onChange={(e) => setEditTargetUserLabel(e.target.value)}
                  placeholder="Target user label (optional)"
                  style={{ padding: 8 }}
                />
                <input
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/..."
                  style={{ padding: 8 }}
                />
                <textarea
                  value={editKeywordText}
                  onChange={(e) => setEditKeywordText(e.target.value)}
                  rows={3}
                  placeholder="Keywords (optional, comma/newline separated; empty = all global keywords)"
                  style={{ width: "100%", padding: 8 }}
                />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <label style={{ fontSize: 14 }}>
                    <input
                      type="radio"
                      name={`preview-mode-${t.id}`}
                      checked={editPreviewUseDefault}
                      onChange={() => setEditPreviewUseDefault(true)}
                    />{" "}
                    Default (yesterday)
                  </label>
                  <label style={{ fontSize: 14 }}>
                    <input
                      type="radio"
                      name={`preview-mode-${t.id}`}
                      checked={!editPreviewUseDefault}
                      onChange={() => setEditPreviewUseDefault(false)}
                    />{" "}
                    Custom range
                  </label>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <label style={{ fontSize: 14 }}>
                    Default preview start:{" "}
                    <input
                      type="date"
                      value={editPreviewStartDate}
                      onChange={(e) => setEditPreviewStartDate(e.target.value)}
                      style={{ marginLeft: 6 }}
                      disabled={editPreviewUseDefault}
                    />
                  </label>
                  <label style={{ fontSize: 14 }}>
                    Default preview end:{" "}
                    <input
                      type="date"
                      value={editPreviewEndDate}
                      onChange={(e) => setEditPreviewEndDate(e.target.value)}
                      style={{ marginLeft: 6 }}
                      disabled={editPreviewUseDefault}
                    />
                  </label>
                </div>
                <div style={{ fontSize: 13, color: "#64748b" }}>
                  Choose "Default" to reset saved range; choose "Custom range" to save dates (max 14 days).
                </div>
                <label style={{ fontSize: 14 }}>
                  <input
                    type="checkbox"
                    checked={editEnabled}
                    onChange={(e) => setEditEnabled(e.target.checked)}
                  />{" "}
                  Enabled
                </label>
              </div>
            ) : (
              <>
                <strong>{t.name}</strong> {t.enabled ? "" : "(disabled)"}
                {t.target_user_label && (
                  <div style={{ fontSize: 13, color: "#334155", marginTop: 4 }}>
                    user label: <code>{t.target_user_label}</code>
                  </div>
                )}
                {t.target_preview_start_date && t.target_preview_end_date && (
                  <div style={{ fontSize: 13, color: "#334155", marginTop: 4 }}>
                    default preview range:{" "}
                    <code>
                      {t.target_preview_start_date} to {t.target_preview_end_date}
                    </code>
                  </div>
                )}
                <div style={{ fontSize: 13, wordBreak: "break-all", marginTop: 4 }}>{t.webhook_url}</div>
              </>
            )}
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={async () => {
                  if (editingTargetId === t.id) {
                    try {
                      if (!editPreviewUseDefault && (!editPreviewStartDate || !editPreviewEndDate)) {
                        onErr("For custom range, set both start and end dates.");
                        return;
                      }
                      const keywordIds = await resolveKeywordIdsFromText(editKeywordText);
                      await apiClient.patch(`/api/feishu-targets/${t.id}`, {
                        name: editName,
                        target_user_label: editTargetUserLabel,
                        target_preview_start_date: editPreviewUseDefault ? "" : editPreviewStartDate,
                        target_preview_end_date: editPreviewUseDefault ? "" : editPreviewEndDate,
                        webhook_url: editUrl,
                        enabled: editEnabled,
                        keyword_ids: keywordIds,
                      });
                      setEditingTargetId(null);
                      await load();
                      onOk("Target updated");
                    } catch (e) {
                      onErr(e);
                    }
                    return;
                  }
                  const currentKw = keywords
                    .filter((k) => t.keyword_ids.includes(k.id))
                    .map((k) => k.phrase)
                    .join(", ");
                  setEditingTargetId(t.id);
                  setEditName(t.name);
                  setEditTargetUserLabel(t.target_user_label || "");
                  setEditUrl(t.webhook_url);
                  setEditKeywordText(currentKw);
                  setEditEnabled(t.enabled);
                  setEditPreviewStartDate(t.target_preview_start_date || "");
                  setEditPreviewEndDate(t.target_preview_end_date || "");
                  setEditPreviewUseDefault(
                    !(t.target_preview_start_date && t.target_preview_end_date)
                  );
                }}
              >
                {editingTargetId === t.id ? "Save target" : "Edit target"}
              </button>
              {editingTargetId === t.id && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingTargetId(null);
                  }}
                >
                  Cancel edit
                </button>
              )}
              <button
                type="button"
                onClick={async () => {
                  try {
                    await apiClient.post(`/api/feishu-targets/${t.id}/test`, {});
                    onOk("Test sent");
                  } catch (e) {
                    onErr(e);
                  }
                }}
              >
                Test webhook
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const res = await apiClient.post<Record<string, unknown>>(
                      `/api/feishu-targets/${t.id}/sample-digest`,
                      {}
                    );
                    onOk(
                      `Real API preview sent (range: ${String(res.start_date ?? "-")} to ${String(
                        res.end_date ?? "-"
                      )}, matched: ${String(res.matched_papers ?? 0)}, sent: ${String(
                        res.sent_lines ?? 0
                      )})`
                    );
                  } catch (e) {
                    onErr(e);
                  }
                }}
              >
                Send real API digest preview
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await apiClient.patch(`/api/feishu-targets/${t.id}`, { enabled: !t.enabled });
                    await load();
                    onOk("Updated");
                  } catch (e) {
                    onErr(e);
                  }
                }}
              >
                {t.enabled ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!confirm("Delete this target?")) return;
                  try {
                    await apiClient.delete(`/api/feishu-targets/${t.id}`);
                    await load();
                    onOk("Deleted");
                  } catch (e) {
                    onErr(e);
                  }
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WeChatPanel({
  onOk,
  onErr,
}: {
  onOk: (s: string) => void;
  onErr: (e: unknown) => void;
}) {
  const [settings, setSettings] = useState<WeChatSettings | null>(null);
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [mapping, setMapping] = useState("");
  const [subs, setSubs] = useState<WeChatSubscriber[]>([]);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [openid, setOpenid] = useState("");
  const [label, setLabel] = useState("");
  const [subscriberKeywordText, setSubscriberKeywordText] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, sub, k] = await Promise.all([
        apiClient.get<WeChatSettings>("/api/wechat-settings"),
        apiClient.get<WeChatSubscriber[]>("/api/wechat-subscribers"),
        apiClient.get<Keyword[]>("/api/keywords"),
      ]);
      setSettings(s);
      setAppId(s.app_id);
      setTemplateId(s.template_id);
      setMapping(s.field_mapping);
      setSubs(sub);
      setKeywords(k);
    } catch (e) {
      onErr(e);
    }
  }, [onErr]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <h3>MP settings</h3>
      <p style={{ fontSize: 14, color: "#64748b" }}>
        Template <code>data</code> keys must match your 公众号 template (default maps{" "}
        <code>digest_title</code>, <code>digest_body</code>, <code>link</code> → <code>thing1</code>,{" "}
        <code>thing2</code>, <code>url</code>).
      </p>
      <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
        <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="AppID" style={{ padding: 8 }} />
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={settings?.has_app_secret ? "New app secret (leave empty to keep)" : "App secret"}
          style={{ padding: 8 }}
        />
        <input
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
          placeholder="Template ID"
          style={{ padding: 8 }}
        />
        <textarea
          value={mapping}
          onChange={(e) => setMapping(e.target.value)}
          rows={3}
          placeholder='{"digest_title":"thing1","digest_body":"thing2","link":"url"}'
          style={{ width: "100%", fontFamily: "monospace", padding: 8 }}
        />
        <button
          type="button"
          onClick={async () => {
            try {
              const body: Record<string, string> = {
                app_id: appId,
                template_id: templateId,
                field_mapping: mapping,
              };
              if (secret.trim()) body.app_secret = secret;
              await apiClient.patch("/api/wechat-settings", body);
              setSecret("");
              await load();
              onOk("WeChat settings saved");
            } catch (e) {
              onErr(e);
            }
          }}
        >
          Save settings
        </button>
      </div>

      <h3>Subscribers</h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <input value={openid} onChange={(e) => setOpenid(e.target.value)} placeholder="openid" style={{ padding: 8, flex: 1, minWidth: 200 }} />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="label" style={{ padding: 8, width: 160 }} />
        <textarea
          value={subscriberKeywordText}
          onChange={(e) => setSubscriberKeywordText(e.target.value)}
          rows={2}
          placeholder="Optional keywords for this subscriber, comma/newline separated"
          style={{ padding: 8, minWidth: 280, flex: 2 }}
        />
        <button
          type="button"
          onClick={async () => {
            try {
              const keywordIds = await resolveKeywordIdsFromText(subscriberKeywordText);
              await apiClient.post("/api/wechat-subscribers", {
                openid,
                label,
                enabled: true,
                keyword_ids: keywordIds,
              });
              setOpenid("");
              setLabel("");
              setSubscriberKeywordText("");
              await load();
              onOk("Subscriber added");
            } catch (e) {
              onErr(e);
            }
          }}
          disabled={!openid.trim()}
        >
          Add subscriber
        </button>
      </div>
      <div style={{ fontSize: 13, color: "#64748b", marginBottom: 8 }}>
        Existing global keywords: {keywords.map((k) => k.phrase).join(", ") || "(none yet)"}
      </div>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {subs.map((s) => (
          <li key={s.id} style={{ border: "1px solid #e2e8f0", padding: 12, marginBottom: 8, borderRadius: 8, background: "#fff" }}>
            <code>{s.openid}</code> {s.label && <span>— {s.label}</span>}
            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await apiClient.post(`/api/wechat-subscribers/${s.id}/test`, {});
                    onOk("Template test sent");
                  } catch (e) {
                    onErr(e);
                  }
                }}
              >
                Test template
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await apiClient.patch(`/api/wechat-subscribers/${s.id}`, { enabled: !s.enabled });
                    await load();
                    onOk("Updated");
                  } catch (e) {
                    onErr(e);
                  }
                }}
              >
                {s.enabled ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!confirm("Remove subscriber?")) return;
                  try {
                    await apiClient.delete(`/api/wechat-subscribers/${s.id}`);
                    await load();
                    onOk("Removed");
                  } catch (e) {
                    onErr(e);
                  }
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
