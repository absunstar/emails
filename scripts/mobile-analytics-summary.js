'use strict';
const path = require('path');
const { createMobileAnalytics } = require('../apps/emails/core/mobile-analytics');
const root = path.resolve(__dirname, '..');
const metrics = createMobileAnalytics({
    baseDir: process.env.EMAIL_MOBILE_ANALYTICS_DIR ||
        path.join(root, 'localStorage', 'mobile-analytics'),
});
process.stdout.write(JSON.stringify(metrics.summary({ periodDays: Number(process.argv[2]) || 28 }), null, 2) + '\n');
