// Typecheck only; do not execute. Two errors are expected on the audited revision.
// bun x tsc --noEmit --strict --skipLibCheck --moduleResolution bundler --module esnext --target esnext docs/audits/2026-09-08-gateways/paypal-types.ts
import { createPaymentClient, paypalGateway, money } from '../../../packages/core/dist/index.js';

const client = createPaymentClient({
  gateways: { paypal: paypalGateway({ clientId: 'audit', clientSecret: 'audit', sandbox: true }) },
  defaultGateway: 'paypal',
});

// Positive control: the explicit built-in overload supports the documented URL.
client.createPayment({ amount: money('10', 'USD'), currency: 'USD', returnUrl: 'https://merchant.example/return' }, 'paypal');

// Both equivalent public paths incorrectly expose only common CreatePaymentParams.
client.createPayment({ amount: money('10', 'USD'), currency: 'USD', returnUrl: 'https://merchant.example/return' });
client.gateway('paypal').createPayment({ amount: money('10', 'USD'), currency: 'USD', returnUrl: 'https://merchant.example/return' });
