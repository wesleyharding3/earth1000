import { registerPlugin } from '@capacitor/core';
const Purchases = registerPlugin('Purchases', {
    web: () => import('./web').then((m) => new m.PurchasesWeb()),
});
export * from './definitions';
export { Purchases };
//# sourceMappingURL=index.js.map