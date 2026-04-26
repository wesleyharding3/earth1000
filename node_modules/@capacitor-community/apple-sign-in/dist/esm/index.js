import { registerPlugin } from '@capacitor/core';
const SignInWithApple = registerPlugin('SignInWithApple', {
    web: () => import('./web').then((m) => new m.SignInWithAppleWeb()),
});
export * from './definitions';
export { SignInWithApple };
//# sourceMappingURL=index.js.map