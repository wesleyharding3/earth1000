'use strict';

var core = require('@capacitor/core');
var $script = require('scriptjs');

function _interopNamespaceDefault(e) {
    var n = Object.create(null);
    if (e) {
        Object.keys(e).forEach(function (k) {
            if (k !== 'default') {
                var d = Object.getOwnPropertyDescriptor(e, k);
                Object.defineProperty(n, k, d.get ? d : {
                    enumerable: true,
                    get: function () { return e[k]; }
                });
            }
        });
    }
    n.default = e;
    return Object.freeze(n);
}

var $script__namespace = /*#__PURE__*/_interopNamespaceDefault($script);

const SignInWithApple = core.registerPlugin('SignInWithApple', {
    web: () => Promise.resolve().then(function () { return web; }).then((m) => new m.SignInWithAppleWeb()),
});

class SignInWithAppleWeb extends core.WebPlugin {
    constructor() {
        super(...arguments);
        this.appleScriptUrl = 'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js';
        this.isAppleScriptLoaded = false;
    }
    async authorize(options) {
        return new Promise((resolve, reject) => {
            if (options) {
                this.loadSignInWithAppleJS().then((loaded) => {
                    var _a, _b, _c;
                    this.isAppleScriptLoaded = loaded;
                    if (this.isAppleScriptLoaded) {
                        AppleID.auth.init({
                            clientId: options.clientId,
                            redirectURI: options.redirectURI,
                            scope: (_a = options.scopes) !== null && _a !== undefined ? _a : undefined,
                            state: (_b = options.state) !== null && _b !== undefined ? _b : undefined,
                            nonce: (_c = options.nonce) !== null && _c !== undefined ? _c : undefined,
                            usePopup: true,
                        });
                        AppleID.auth
                            .signIn()
                            .then((res) => {
                            var _a, _b, _c, _d, _e;
                            const response = {
                                response: {
                                    user: null,
                                    email: (_a = res.user) === null || _a === undefined ? undefined : _a.email,
                                    givenName: (_c = (_b = res.user) === null || _b === undefined ? undefined : _b.name) === null || _c === undefined ? undefined : _c.firstName,
                                    familyName: (_e = (_d = res.user) === null || _d === undefined ? undefined : _d.name) === null || _e === undefined ? undefined : _e.lastName,
                                    identityToken: res.authorization.id_token,
                                    authorizationCode: res.authorization.code,
                                },
                            };
                            resolve(response);
                        })
                            .catch((err) => {
                            reject(err);
                        });
                    }
                    else {
                        reject('Unable to load Sign in with Apple JS framework.');
                    }
                });
            }
            else {
                reject('No options were provided.');
            }
        });
    }
    loadSignInWithAppleJS() {
        return new Promise((resolve) => {
            if (!this.isAppleScriptLoaded) {
                if (typeof window !== undefined) {
                    $script__namespace.get(this.appleScriptUrl, () => resolve(true));
                }
                else {
                    resolve(false);
                }
            }
            else {
                resolve(true);
            }
        });
    }
}

var web = /*#__PURE__*/Object.freeze({
    __proto__: null,
    SignInWithAppleWeb: SignInWithAppleWeb
});

exports.SignInWithApple = SignInWithApple;
//# sourceMappingURL=plugin.cjs.js.map
