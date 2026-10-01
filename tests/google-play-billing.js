'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createGooglePlayBilling, GOOGLE_TOKEN_URL } = require('../apps/emails/core/google-play-billing');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

(async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        if (String(url) === GOOGLE_TOKEN_URL) {
            return new Response(JSON.stringify({ access_token: 'oauth-test', expires_in: 3600 }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (String(url).endsWith(':acknowledge')) {
            assert.strictEqual(init.method, 'POST');
            assert.strictEqual(init.headers.authorization, 'Bearer oauth-test');
            return new Response('', { status: 200 });
        }
        if (String(url).endsWith('/edits') && init.method === 'POST') {
            assert.strictEqual(init.headers.authorization, 'Bearer oauth-test');
            return new Response(JSON.stringify({
                id: 'edit-test',
                expiryTimeSeconds: '1800003600',
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (String(url).endsWith('/edits/edit-test:validate') && init.method === 'POST') {
            return new Response(JSON.stringify({
                id: 'edit-test',
                expiryTimeSeconds: '1800003600',
            }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (String(url).endsWith('/edits/edit-test') && init.method === 'DELETE') {
            return new Response('', { status: 200 });
        }
        assert.strictEqual(init.method, 'GET');
        assert.strictEqual(init.headers.authorization, 'Bearer oauth-test');
        return new Response(JSON.stringify({
            purchaseState: 0,
            acknowledgementState: 0,
            consumptionState: 0,
            productId: 'vip_temp_mail_pro_lifetime',
            orderId: 'GPA.test',
            purchaseTimeMillis: '123456',
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    const billing = createGooglePlayBilling({
        serviceAccountEmail: 'billing-test@example.iam.gserviceaccount.com',
        privateKey: pem,
        fetchImpl,
        now: () => 1_800_000_000_000,
        cacheTtlMs: 60_000,
    });

    assert.strictEqual(billing.isConfigured(), true);
    const verified = await billing.verifyAndAcknowledge('purchase-token-test');
    assert.strictEqual(verified.valid, true);
    assert.strictEqual(verified.acknowledgementState, 1);
    assert.strictEqual(calls.length, 3, 'OAuth + verify + acknowledge expected');

    const cached = await billing.verifyPurchase('purchase-token-test');
    assert.strictEqual(cached.valid, true);
    assert.strictEqual(cached.cached, true);
    assert.strictEqual(calls.length, 3, 'cached verification must not call Google again');


    const edit = await billing.createEdit();
    assert.strictEqual(edit.id, 'edit-test');
    const validatedEdit = await billing.validateEdit(edit.id);
    assert.strictEqual(validatedEdit.id, 'edit-test');
    assert.strictEqual(await billing.deleteEdit(edit.id), true);


    const unconfigured = createGooglePlayBilling({
        fetchImpl,
        serviceAccountEmailFile: '/tmp/does-not-exist-email.txt',
        privateKeyFile: '/tmp/does-not-exist-key.pem',
    });
    await assert.rejects(
        () => unconfigured.verifyPurchase('purchase-token-test'),
        (error) => error && error.code === 'GOOGLE_PLAY_NOT_CONFIGURED'
    );

    console.log('Google Play billing verification tests passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
