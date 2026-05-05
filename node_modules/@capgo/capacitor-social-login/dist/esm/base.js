import { WebPlugin } from '@capacitor/core';
export class BaseSocialLogin extends WebPlugin {
    constructor() {
        super();
    }
    parseJwt(token) {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64)
            .split('')
            .map((c) => {
            return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        })
            .join(''));
        return JSON.parse(jsonPayload);
    }
    async loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => {
                resolve();
            };
            script.onerror = reject;
            document.body.appendChild(script);
        });
    }
}
BaseSocialLogin.OAUTH_STATE_KEY = 'social_login_oauth_pending';
//# sourceMappingURL=base.js.map