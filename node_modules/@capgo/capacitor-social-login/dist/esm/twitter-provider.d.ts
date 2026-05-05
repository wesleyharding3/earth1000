import { BaseSocialLogin } from './base';
import type { AuthorizationCode, LoginResult, ProviderResponseMap, TwitterLoginOptions } from './definitions';
export declare class TwitterSocialLogin extends BaseSocialLogin {
    private clientId;
    private redirectUrl;
    private defaultScopes;
    private forceLogin;
    private audience?;
    private readonly TOKENS_KEY;
    private readonly STATE_PREFIX;
    initialize(clientId: string | null, redirectUrl?: string | null, defaultScopes?: string[], forceLogin?: boolean, audience?: string): Promise<void>;
    login<T extends 'twitter'>(options: TwitterLoginOptions): Promise<{
        provider: T;
        result: ProviderResponseMap[T];
    }>;
    logout(): Promise<void>;
    isLoggedIn(): Promise<{
        isLoggedIn: boolean;
    }>;
    getAuthorizationCode(): Promise<AuthorizationCode>;
    refresh(): Promise<void>;
    handleOAuthRedirect(url: URL, expectedState?: string): Promise<LoginResult | {
        error: string;
    } | null>;
    private exchangeAuthorizationCode;
    private refreshWithRefreshToken;
    private fetchProfile;
    private persistTokens;
    private getStoredTokens;
    private persistPendingLogin;
    private consumePendingLogin;
    private generateState;
    private generateCodeVerifier;
    private generateCodeChallenge;
    private base64UrlEncode;
}
