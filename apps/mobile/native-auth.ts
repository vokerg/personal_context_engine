import { AuthRequest, ResponseType } from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { MobileSession, type OAuthPlatform } from "./session";

WebBrowser.maybeCompleteAuthSession();
const callback = "pce://oauth/callback" as const;
const refreshKey = "pce.oauth.ios.refresh.v1";
const platform: OAuthPlatform = {
  async createAuthorization(config) {
    const request = new AuthRequest({
      clientId: config.clientId,
      redirectUri: config.callback,
      responseType: ResponseType.Code,
      scopes: [...config.scopes],
      usePKCE: true,
      extraParams: { resource: config.apiOrigin + "/mcp" },
    });
    const url = await request.makeAuthUrlAsync({
      authorizationEndpoint: config.apiOrigin + "/oauth/authorize",
    });
    if (!request.codeVerifier) throw new Error("PKCE unavailable");
    return { url, state: request.state, codeVerifier: request.codeVerifier };
  },
  async openAuthorization(url, redirect) {
    const result = await WebBrowser.openAuthSessionAsync(url, redirect);
    return result.type === "success" ? result.url : null;
  },
  readRefresh: () => SecureStore.getItemAsync(refreshKey),
  writeRefresh: (value) => SecureStore.setItemAsync(refreshKey, value, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }),
  clearRefresh: () => SecureStore.deleteItemAsync(refreshKey),
};
export function createNativeSession(): MobileSession | null {
  const baseUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
  const clientId = process.env.EXPO_PUBLIC_OAUTH_CLIENT_ID;
  if (!baseUrl || !clientId) return null;
  try {
    return new MobileSession({
      apiOrigin: baseUrl,
      clientId,
      callback,
      scopes: ["notes:read", "capture:write", "tags:write"],
    }, platform);
  } catch {
    return null;
  }
}
