const TOKEN_KEY = "arxiv_digest_admin_token";

/** Strip wrapping quotes and optional `Bearer ` prefix (common copy-paste mistake). */
export function normalizeAdminToken(raw: string): string {
  let t = raw.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }
  if (/^bearer\s+/i.test(t)) {
    t = t.replace(/^bearer\s+/i, "").trim();
  }
  return t;
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string) {
  sessionStorage.setItem(TOKEN_KEY, normalizeAdminToken(token));
}

export function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY);
}

async function api<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {
    ...(init.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  if (init.body && !(init.body instanceof FormData)) {
    (headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const r = await fetch(path, { ...init, headers });
  if (r.status === 401) {
    clearToken();
    throw new Error("Unauthorized — check admin token");
  }
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const j = await r.json();
      if (j.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  if (r.status === 204) return undefined as T;
  return r.json() as Promise<T>;
}

export const apiClient = {
  get: <T>(p: string) => api<T>(p),
  post: <T>(p: string, body?: unknown) =>
    api<T>(p, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(p: string, body: unknown) =>
    api<T>(p, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(p: string) => api<T>(p, { method: "DELETE" }),
};

export type Keyword = { id: number; phrase: string; created_at: string };
export type FeishuTarget = {
  id: number;
  name: string;
  target_user_label: string;
  target_preview_start_date: string;
  target_preview_end_date: string;
  webhook_url: string;
  enabled: boolean;
  keyword_ids: number[];
  created_at: string;
};
export type WeChatSettings = {
  app_id: string;
  template_id: string;
  field_mapping: string;
  has_app_secret: boolean;
  updated_at: string;
};
export type WeChatSubscriber = {
  id: number;
  openid: string;
  label: string;
  enabled: boolean;
  keyword_ids: number[];
  created_at: string;
};
