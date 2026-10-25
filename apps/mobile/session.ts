/**
 * Native public OAuth client. No bearer token is persisted; the platform must
 * implement secure refresh-token storage and a system-browser PKCE request.
 * This file deliberately has no React Native imports for synthetic testing.
 */
export type SessionPhase = "restoring" | "signed-out" | "signed-in";
export type SessionView = {
  phase: SessionPhase;
  notice: string;
  revision: number;
};
export type AuthorizationAttempt = {
  url: string;
  state: string;
  codeVerifier: string;
};
export interface OAuthPlatform {
  createAuthorization(config: MobileOAuthConfig): Promise<AuthorizationAttempt>;
  openAuthorization(url: string, callback: string): Promise<string | null>;
  readRefresh(): Promise<string | null>;
  writeRefresh(token: string): Promise<void>;
  clearRefresh(): Promise<void>;
}
export type MobileOAuthConfig = {
  apiOrigin: string;
  clientId: string;
  callback: "pce://oauth/callback";
  scopes: readonly string[];
};
type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: "Bearer";
  scope: string;
};
const TOKEN = /^[A-Za-z0-9_-]{64}$/;
const CODE = /^[A-Za-z0-9_-]{64}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export function verifiedConfig(config: MobileOAuthConfig): MobileOAuthConfig {
  const url = new URL(config.apiOrigin);
  if (
    url.origin !== config.apiOrigin ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(config.clientId) ||
    config.callback !== "pce://oauth/callback" ||
    !config.scopes.length ||
    new Set(config.scopes).size !== config.scopes.length ||
    config.scopes.some(
      (scope) =>
        ![
          "notes:read",
          "capture:write",
          "tags:write",
          "tasks:read",
          "tasks:write",
        ].includes(scope),
    ) ||
    !config.scopes.includes("notes:read")
  )
    throw new Error("Invalid native OAuth configuration");
  return config;
}

/** Fail closed on issuer/state/redirect mismatch, duplicate or injected params. */
export function parseNativeCallback(
  input: string,
  config: MobileOAuthConfig,
  expectedState: string,
): string {
  const url = new URL(input);
  if (
    url.protocol !== "pce:" ||
    url.hostname !== "oauth" ||
    url.pathname !== "/callback" ||
    url.username ||
    url.password ||
    url.hash ||
    !["code", "state", "iss", "error"].every(
      (key) => url.searchParams.getAll(key).length <= 1,
    ) ||
    [...url.searchParams.keys()].some(
      (key) => !["code", "state", "iss", "error"].includes(key),
    ) ||
    url.searchParams.get("state") !== expectedState ||
    url.searchParams.get("iss") !== config.apiOrigin ||
    input.split("?")[0] !== config.callback
  )
    throw new Error("Invalid authorization response");
  if (url.searchParams.has("error")) {
    if (url.searchParams.get("error") === "access_denied")
      throw new Error("Authorization denied");
    throw new Error("Invalid authorization response");
  }
  const code = url.searchParams.get("code");
  if (!code || !CODE.test(code))
    throw new Error("Invalid authorization response");
  return code;
}
function parseToken(value: unknown, config: MobileOAuthConfig): TokenResponse {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid token response");
  const token = value as Record<string, unknown>;
  if (
    typeof token.access_token !== "string" ||
    !TOKEN.test(token.access_token) ||
    typeof token.refresh_token !== "string" ||
    !TOKEN.test(token.refresh_token) ||
    token.token_type !== "Bearer" ||
    typeof token.expires_in !== "number" ||
    token.expires_in < 1 ||
    token.expires_in > 900 ||
    typeof token.scope !== "string" ||
    !token.scope.split(" ").includes("notes:read") ||
    token.scope.split(" ").some((scope) => !config.scopes.includes(scope))
  )
    throw new Error("Invalid token response");
  return token as unknown as TokenResponse;
}

export class MobileSession {
  private access: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt = 0;
  private refreshInFlight: Promise<string | null> | null = null;
  private signingIn = false;
  private signingOut = false;
  private epoch = 0;
  private listeners = new Set<(snapshot: SessionView) => void>();
  private view: SessionView = { phase: "restoring", notice: "", revision: 0 };
  readonly config: MobileOAuthConfig;
  constructor(
    config: MobileOAuthConfig,
    private readonly platform: OAuthPlatform,
    private readonly request: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    this.config = verifiedConfig(config);
  }
  get snapshot(): SessionView {
    return this.view;
  }
  subscribe(listener: (snapshot: SessionView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit(phase: SessionPhase, notice = "") {
    this.view = { phase, notice, revision: this.view.revision + 1 };
    for (const listener of this.listeners) listener(this.view);
  }
  private async post(path: string, fields: Record<string, string>) {
    const response = await this.request(this.config.apiOrigin + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "error",
    });
    if (!response.ok) {
      if (response.status === 400 || response.status === 401)
        throw new Error("invalid_grant");
      throw new Error("auth_unavailable");
    }
    return response;
  }
  private async accept(response: Response, version: number) {
    const data = parseToken(await response.json(), this.config);
    if (version !== this.epoch) return null;
    // Persistence MUST succeed before treating the new rotating credential as usable.
    await this.platform.writeRefresh(data.refresh_token);
    if (version !== this.epoch) {
      await this.platform.clearRefresh();
      return null;
    }
    this.refreshToken = data.refresh_token;
    this.access = data.access_token;
    this.expiresAt = this.clock() + data.expires_in * 1000;
    this.emit("signed-in");
    return this.access;
  }
  private async invalidate(notice: string) {
    this.access = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    await this.platform.clearRefresh();
    this.emit("signed-out", notice);
  }
  async restore(): Promise<void> {
    const version = this.epoch;
    this.emit("restoring");
    try {
      const stored = await this.platform.readRefresh();
      if (version !== this.epoch) return;
      if (!stored) {
        this.emit("signed-out");
        return;
      }
      if (!TOKEN.test(stored)) {
        await this.invalidate("Sign in again.");
        return;
      }
      this.refreshToken = stored;
      await this.getAccessToken();
    } catch {
      if (version === this.epoch)
        this.emit(
          "signed-out",
          "Could not restore session. Retry when online.",
        );
    }
  }
  async signIn(): Promise<void> {
    if (this.signingIn) return;
    this.signingIn = true;
    const version = ++this.epoch;
    try {
      const attempt = await this.platform.createAuthorization(this.config);
      if (!VERIFIER.test(attempt.codeVerifier) || attempt.state.length < 16)
        throw new Error("Invalid authorization request");
      // No native URL ever contains access or refresh tokens.
      const returnUrl = await this.platform.openAuthorization(
        attempt.url,
        this.config.callback,
      );
      if (version !== this.epoch) return;
      if (!returnUrl) {
        this.emit("signed-out", "Sign-in cancelled.");
        return;
      }
      const code = parseNativeCallback(returnUrl, this.config, attempt.state);
      const response = await this.post("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: this.config.clientId,
        redirect_uri: this.config.callback,
        resource: this.config.apiOrigin + "/mcp",
        code_verifier: attempt.codeVerifier,
      });
      await this.accept(response, version);
    } catch (error) {
      if (version === this.epoch)
        this.emit(
          "signed-out",
          error instanceof Error && error.message === "Authorization denied"
            ? "Access not granted."
            : "Could not sign in. Check connectivity and configuration.",
        );
    } finally {
      this.signingIn = false;
    }
  }
  async getAccessToken(force = false): Promise<string | null> {
    if (this.signingOut) return null;
    if (!force && this.access && this.expiresAt - this.clock() > 60000)
      return this.access;
    if (this.refreshInFlight) return this.refreshInFlight;
    if (!this.refreshToken) return null;
    const version = this.epoch;
    const refresh = this.refreshToken;
    const task = (async () => {
      try {
        const response = await this.post("/oauth/token", {
          grant_type: "refresh_token",
          refresh_token: refresh,
          client_id: this.config.clientId,
          resource: this.config.apiOrigin + "/mcp",
        });
        return await this.accept(response, version);
      } catch (error) {
        if (version !== this.epoch) return null;
        if (error instanceof Error && error.message === "invalid_grant") {
          await this.invalidate("Session expired or revoked. Sign in again.");
          return null;
        }
        // Transient failures must retain the last secure refresh credential.
        this.access = null;
        this.emit(
          "signed-out",
          "Unable to refresh session. Retry when online.",
        );
        return null;
      }
    })();
    this.refreshInFlight = task;
    try {
      return await task;
    } finally {
      if (this.refreshInFlight === task) this.refreshInFlight = null;
    }
  }
  /** On a 401 force a single refresh; 403 is a scope error, not a login prompt. */
  forceRefresh(): Promise<string | null> {
    this.access = null;
    return this.getAccessToken(true);
  }
  async signOut(): Promise<void> {
    this.signingOut = true;
    // Do not revoke an already-rotated credential: wait for the single flight.
    try {
      await this.refreshInFlight;
    } catch {
      /* Local sign-out still proceeds. */
    }
    const token = this.refreshToken;
    ++this.epoch;
    this.access = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    try {
      await this.platform.clearRefresh();
      this.emit("signed-out");
      if (token) {
        try {
          await this.post("/oauth/revoke", {
            token,
            client_id: this.config.clientId,
            token_type_hint: "refresh_token",
          });
        } catch {
          this.emit(
            "signed-out",
            "Signed out here; server revocation could not be confirmed.",
          );
        }
      }
    } finally {
      this.signingOut = false;
    }
  }
}
