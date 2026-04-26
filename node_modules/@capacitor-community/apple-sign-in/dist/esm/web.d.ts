import { WebPlugin } from '@capacitor/core';
import type { SignInWithAppleOptions, SignInWithApplePlugin, SignInWithAppleResponse } from './definitions';
export declare class SignInWithAppleWeb extends WebPlugin implements SignInWithApplePlugin {
    private appleScriptUrl;
    private isAppleScriptLoaded;
    authorize(options?: SignInWithAppleOptions): Promise<SignInWithAppleResponse>;
    private loadSignInWithAppleJS;
}
