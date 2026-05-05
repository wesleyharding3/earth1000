import { WebPlugin } from '@capacitor/core';
export declare class BaseSocialLogin extends WebPlugin {
    protected static readonly OAUTH_STATE_KEY = "social_login_oauth_pending";
    constructor();
    protected parseJwt(token: string): any;
    protected loadScript(src: string): Promise<void>;
}
