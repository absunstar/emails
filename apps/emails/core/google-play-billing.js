'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

function base64url(value) {
    return Buffer.from(value).toString('base64url');
}


function readOptionalText(filePath) {
    try {
        if (!filePath || !fs.existsSync(filePath)) return '';
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch (_) {
        return '';
    }
}

function defaultCredentialPath(fileName) {
    return path.resolve(__dirname, '..', '..', '..', fileName);
}

function normalizePrivateKey(value) {
    return String(value || '').replace(/\\n/g, '\n').trim();
}

function billingError(code, message, status) {
    const error = new Error(message);
    error.code = code;
    if (status) error.status = status;
    return error;
}

function createGooglePlayBilling(options = {}) {
    const packageName = String(options.packageName || process.env.GOOGLE_PLAY_PACKAGE_NAME || 'com.egytag.mails').trim();
    const productId = String(options.productId || process.env.GOOGLE_PLAY_PRO_PRODUCT_ID || 'vip_temp_mail_pro_lifetime').trim();

    const emailFile = String(
        options.serviceAccountEmailFile ||
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL_FILE ||
        defaultCredentialPath('google-play-service-account-email.txt')
    ).trim();
    const keyFile = String(
        options.privateKeyFile ||
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY_FILE ||
        defaultCredentialPath('google-play-service-account.pem')
    ).trim();

    const serviceAccountEmail = String(
        options.serviceAccountEmail ||
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL ||
        readOptionalText(emailFile) ||
        ''
    ).trim();
    const privateKey = normalizePrivateKey(
        options.privateKey ||
        process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY ||
        readOptionalText(keyFile) ||
        ''
    );
    const fetchImpl = options.fetchImpl || global.fetch;
    const now = options.now || (() => Date.now());
    const cacheTtlMs = Number(options.cacheTtlMs || process.env.GOOGLE_PLAY_VERIFY_CACHE_MS || 6 * 60 * 60 * 1000);
    const verifyCache = new Map();
    let oauth = null;

    function isConfigured() {
        return !!(serviceAccountEmail && privateKey && typeof fetchImpl === 'function');
    }

    function tokenHash(token) {
        return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
    }

    function cachedPurchase(token, expectedProductId) {
        const key = tokenHash(token) + ':' + expectedProductId;
        const item = verifyCache.get(key);
        if (!item) return null;
        if (item.expiresAt <= now()) {
            verifyCache.delete(key);
            return null;
        }
        return item.value;
    }

    function rememberPurchase(token, expectedProductId, value) {
        const key = tokenHash(token) + ':' + expectedProductId;
        verifyCache.set(key, {
            expiresAt: now() + Math.max(60_000, cacheTtlMs),
            value,
        });
        if (verifyCache.size > 5000) {
            const time = now();
            for (const [cacheKey, item] of verifyCache) {
                if (!item || item.expiresAt <= time || verifyCache.size > 4500) verifyCache.delete(cacheKey);
                if (verifyCache.size <= 4500) break;
            }
        }
    }

    async function readJson(response) {
        const text = await response.text();
        if (!text) return {};
        try { return JSON.parse(text); } catch (_) {
            throw billingError('GOOGLE_PLAY_INVALID_RESPONSE', 'Google Play returned an invalid response.', response.status);
        }
    }

    async function getAccessToken(force = false) {
        if (!isConfigured()) throw billingError('GOOGLE_PLAY_NOT_CONFIGURED', 'Google Play verification is not configured on the server.', 503);
        if (!force && oauth && oauth.expiresAt > now() + 60_000) return oauth.token;

        const issuedAt = Math.floor(now() / 1000);
        const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
        const payload = base64url(JSON.stringify({
            iss: serviceAccountEmail,
            scope: GOOGLE_SCOPE,
            aud: GOOGLE_TOKEN_URL,
            iat: issuedAt,
            exp: issuedAt + 3600,
        }));
        const unsigned = header + '.' + payload;
        const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
        const assertion = unsigned + '.' + signature;

        const response = await fetchImpl(GOOGLE_TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion,
            }).toString(),
        });
        const data = await readJson(response);
        if (!response.ok || !data.access_token) {
            throw billingError(
                'GOOGLE_PLAY_AUTH_FAILED',
                String(data.error_description || data.error || 'Could not authenticate with Google Play.'),
                response.status
            );
        }

        oauth = {
            token: String(data.access_token),
            expiresAt: now() + Math.max(60, Number(data.expires_in || 3600)) * 1000,
        };
        return oauth.token;
    }

    async function googleRequest(url, init = {}, retry = true) {
        const accessToken = await getAccessToken(false);
        const response = await fetchImpl(url, {
            ...init,
            headers: {
                ...(init.headers || {}),
                authorization: 'Bearer ' + accessToken,
            },
        });
        if (response.status === 401 && retry) {
            oauth = null;
            await getAccessToken(true);
            return googleRequest(url, init, false);
        }
        return response;
    }

    function editsBaseUrl() {
        return 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
            encodeURIComponent(packageName) + '/edits';
    }

    async function createEdit() {
        const response = await googleRequest(editsBaseUrl(), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        const data = await readJson(response);
        if (!response.ok || !data.id) {
            throw billingError(
                'GOOGLE_PLAY_EDIT_CREATE_FAILED',
                String(data?.error?.message || data.error || 'Google Play could not create an app edit.'),
                response.status
            );
        }
        return {
            id: String(data.id),
            expiryTimeSeconds: String(data.expiryTimeSeconds || ''),
        };
    }

    async function validateEdit(editId) {
        const id = String(editId || '').trim();
        if (!id) throw billingError('EDIT_ID_REQUIRED', 'Google Play edit ID is required.', 400);
        const response = await googleRequest(
            editsBaseUrl() + '/' + encodeURIComponent(id) + ':validate',
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: '{}',
            }
        );
        const data = await readJson(response);
        if (!response.ok) {
            throw billingError(
                'GOOGLE_PLAY_EDIT_VALIDATE_FAILED',
                String(data?.error?.message || data.error || 'Google Play could not validate the app edit.'),
                response.status
            );
        }
        return {
            id: String(data.id || id),
            expiryTimeSeconds: String(data.expiryTimeSeconds || ''),
        };
    }

    async function deleteEdit(editId) {
        const id = String(editId || '').trim();
        if (!id) throw billingError('EDIT_ID_REQUIRED', 'Google Play edit ID is required.', 400);
        const response = await googleRequest(
            editsBaseUrl() + '/' + encodeURIComponent(id),
            { method: 'DELETE' }
        );
        if (!response.ok) {
            const data = await readJson(response);
            throw billingError(
                'GOOGLE_PLAY_EDIT_DELETE_FAILED',
                String(data?.error?.message || data.error || 'Google Play could not delete the app edit.'),
                response.status
            );
        }
        return true;
    }

    async function verifyPurchase(purchaseToken, expectedProductId = productId) {
        const token = String(purchaseToken || '').trim();
        const product = String(expectedProductId || '').trim();
        if (!token) throw billingError('PURCHASE_TOKEN_REQUIRED', 'Google Play purchase token is required.', 400);
        if (!product) throw billingError('PRODUCT_ID_REQUIRED', 'Google Play product ID is required.', 400);

        const cached = cachedPurchase(token, product);
        if (cached) return { ...cached, cached: true };

        const url = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
            encodeURIComponent(packageName) + '/purchases/products/' +
            encodeURIComponent(product) + '/tokens/' + encodeURIComponent(token);

        const response = await googleRequest(url, { method: 'GET' });
        const data = await readJson(response);
        if (!response.ok) {
            throw billingError(
                'GOOGLE_PLAY_VERIFY_FAILED',
                String(data?.error?.message || data.error || 'Google Play could not verify this purchase.'),
                response.status
            );
        }

        const purchaseState = Number(data.purchaseState);
        const validProduct = !data.productId || String(data.productId) === product;
        const valid = purchaseState === 0 && validProduct;
        const value = {
            valid,
            packageName,
            productId: product,
            purchaseState,
            acknowledgementState: Number(data.acknowledgementState || 0),
            consumptionState: Number(data.consumptionState || 0),
            orderId: String(data.orderId || ''),
            purchaseTimeMillis: Number(data.purchaseTimeMillis || 0),
            quantity: Math.max(1, Number(data.quantity || 1)),
            regionCode: String(data.regionCode || ''),
            cached: false,
        };

        if (valid) rememberPurchase(token, product, value);
        return value;
    }

    async function acknowledgePurchase(purchaseToken, expectedProductId = productId) {
        const token = String(purchaseToken || '').trim();
        const product = String(expectedProductId || '').trim();
        const url = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
            encodeURIComponent(packageName) + '/purchases/products/' +
            encodeURIComponent(product) + '/tokens/' + encodeURIComponent(token) + ':acknowledge';
        const response = await googleRequest(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
        if (!response.ok) {
            const data = await readJson(response);
            throw billingError(
                'GOOGLE_PLAY_ACK_FAILED',
                String(data?.error?.message || data.error || 'Google Play could not acknowledge this purchase.'),
                response.status
            );
        }
        return true;
    }

    async function verifyAndAcknowledge(purchaseToken, expectedProductId = productId) {
        const result = await verifyPurchase(purchaseToken, expectedProductId);
        if (!result.valid) return result;
        if (result.acknowledgementState === 0) {
            await acknowledgePurchase(purchaseToken, expectedProductId);
            result.acknowledgementState = 1;
        }
        rememberPurchase(purchaseToken, expectedProductId, result);
        return result;
    }

    return {
        packageName,
        productId,
        isConfigured,
        verifyPurchase,
        acknowledgePurchase,
        verifyAndAcknowledge,
        createEdit,
        validateEdit,
        deleteEdit,
        tokenHash,
    };
}

module.exports = {
    GOOGLE_SCOPE,
    GOOGLE_TOKEN_URL,
    createGooglePlayBilling,
};
