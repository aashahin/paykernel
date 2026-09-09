// file: packages/payments/src/gateways/paypal/paypal.gateway.test.ts
// Comprehensive test suite for PayPal Gateway using Bun test runner

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { PayPalGateway } from './paypal.gateway';
import { HooksManager } from '../../hooks/hooks.manager';
import {
    GatewayApiError,
    InvalidRequestError,
    CardDeclinedError,
    InsufficientFundsError,
    AuthenticationError,
    RateLimitError,
    NetworkError,
    ResourceNotFoundError,
    PaymentAbortedError,
} from '../../errors';
import type { PayPalConfig } from '../../types/config.types';
import type { CreatePaymentParams } from '../../types/payment.types';
import {
    assertNoSecretsInEnvelope,
    hashWebhookPayload,
    toPersistedPaymentEventEnvelope,
} from '../../types/payment-event';
import type { HookContext } from '../../hooks/hooks.types';
import type { Logger } from '../../utils/logger';
import { money, moneyToMajorNumber } from '../../utils/money';
import { isPaidOutcome } from '../../types/operation-result';

/** Logger that records warn/error messages for assertions. */
function captureLogger(sink: string[]): Logger {
    return {
        debug: () => {},
        info: () => {},
        warn: (message: string) => { sink.push(message); },
        error: (message: string) => { sink.push(message); },
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const PAYPAL_TEST_CONFIG: PayPalConfig = {
    clientId: 'test_client_id',
    clientSecret: 'test_client_secret',
    webhookId: 'testwebhookid',
    sandbox: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Mock Fetch Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a mock Response object
 */
function createMockResponse(data: unknown, ok = true, status = 200): Response {
    return {
        ok,
        status,
        json: async () => data,
        headers: new Headers(),
        redirected: false,
        statusText: ok ? 'OK' : 'Error',
        type: 'basic',
        url: '',
        clone: () => createMockResponse(data, ok, status),
        body: null,
        bodyUsed: false,
        arrayBuffer: async () => new ArrayBuffer(0),
        blob: async () => new Blob(),
        formData: async () => new FormData(),
        text: async () => JSON.stringify(data),
    } as Response;
}

/**
 * Create a mock fetch that handles token requests automatically
 */
function createMockFetch(
    apiResponse: unknown,
    apiOk = true,
    apiStatus = 200
): typeof fetch {
    const mockFn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : (input as Request).url;

        // Token request
        if (url.includes('oauth2/token')) {
            return createMockResponse({
                access_token: 'test_token_' + Math.random(),
                expires_in: 3600,
            });
        }

        if (
            apiOk &&
            init?.method === 'POST' &&
            url.endsWith('/v2/checkout/orders') &&
            apiResponse &&
            typeof apiResponse === 'object' &&
            !Array.isArray(apiResponse) &&
            !('links' in apiResponse) &&
            'id' in apiResponse
        ) {
            const order = apiResponse as { id: unknown };
            return createMockResponse({
                ...apiResponse,
                links: [
                    {
                        rel: 'payer-action',
                        href: `https://paypal.com/checkoutnow?token=${String(order.id)}`,
                    },
                ],
            });
        }

        // API request
        return createMockResponse(apiResponse, apiOk, apiStatus);
    }) as unknown as typeof fetch;
    return mockFn;
}

/**
 * Real Response whose `text()` is the raw body (empty / HTML / non-JSON).
 * `createMockResponse` always JSON.stringifies, which cannot represent S20-PAYPAL-JSON.
 */
function createMockRawResponse(body: string, status = 200): Response {
    return new Response(body, { status });
}

function createMockRawFetch(
    body: string,
    apiStatus = 200,
): typeof fetch {
    const mockFn = mock(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : (input as Request).url;

        if (url.includes('oauth2/token')) {
            return createMockResponse({
                access_token: 'test_token_' + Math.random(),
                expires_in: 3600,
            });
        }

        return createMockRawResponse(body, apiStatus);
    }) as unknown as typeof fetch;
    return mockFn;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite
// ═══════════════════════════════════════════════════════════════════════════════

describe('PayPalGateway', () => {
    let gateway: PayPalGateway;
    let hooksManager: HooksManager;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        // Fresh gateway for each test to avoid token caching issues
        hooksManager = new HooksManager({});
        gateway = new PayPalGateway(PAYPAL_TEST_CONFIG, hooksManager);
        // Reset fetch
        globalThis.fetch = originalFetch;
    });

    describe('configuration', () => {
        it('should reject malformed webhook IDs early', () => {
            expect(() => new PayPalGateway({
                clientId: 'test',
                clientSecret: 'test',
                webhookId: 'bad-webhook-id',
            }, hooksManager)).toThrow(InvalidRequestError);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Webhook Verification Tests
    // ═══════════════════════════════════════════════════════════════════════════

    describe('verifyWebhook', () => {
        it('should throw InvalidRequestError directing callers to verifyWebhookAsync', () => {
            expect(() => gateway.verifyWebhook({}, undefined, {})).toThrow(InvalidRequestError);
            expect(() => gateway.verifyWebhook({}, undefined, {})).toThrow(
                /verifyWebhookAsync|handleWebhook/,
            );
        });

        it('should throw even when webhookId is not configured (sync path is unsupported)', () => {
            const gatewayNoWebhookId = new PayPalGateway(
                { clientId: 'test', clientSecret: 'test' },
                hooksManager,
            );

            expect(() => gatewayNoWebhookId.verifyWebhook({}, undefined, {})).toThrow(
                InvalidRequestError,
            );
        });
    });

    describe('verifyWebhookAsync', () => {
        /** Fresh transmission_time so age-based replay rejection does not fire. */
        const validWebhookHeaders = (): Record<string, string> => ({
            'paypal-transmission-id': 'trans-123',
            'paypal-transmission-time': new Date().toISOString(),
            'paypal-transmission-sig': 'signature',
            'paypal-cert-url': 'https://api.paypal.com/cert',
            'paypal-auth-algo': 'SHA256withRSA',
        });

        it('should throw InvalidRequestError when webhookId is not configured', async () => {
            const gatewayNoWebhookId = new PayPalGateway(
                { clientId: 'test', clientSecret: 'test' },
                hooksManager
            );

            await expect(
                gatewayNoWebhookId.verifyWebhookAsync({}, {}),
            ).rejects.toThrow(InvalidRequestError);

            await expect(
                gatewayNoWebhookId.verifyWebhookAsync({}, {}),
            ).rejects.toThrow(/paypal\.webhookId is required for webhook verification/);
        });

        it('should return false when headers are missing', async () => {
            const result = await gateway.verifyWebhookAsync({}, {});
            expect(result).toBe(false);
        });

        it('should return false before calling PayPal when webhook headers exceed PayPal limits', async () => {
            let fetchCount = 0;
            globalThis.fetch = mock(async () => {
                fetchCount++;
                return createMockResponse({});
            }) as unknown as typeof fetch;

            const result = await gateway.verifyWebhookAsync(
                { id: 'event-123' },
                {
                    ...validWebhookHeaders(),
                    'paypal-transmission-id': 'x'.repeat(51),
                }
            );

            expect(result).toBe(false);
            expect(fetchCount).toBe(0);
        });

        it('should reject non-PayPal cert URLs before calling the verify API', async () => {
            let fetchCount = 0;
            globalThis.fetch = mock(async () => {
                fetchCount++;
                return createMockResponse({});
            }) as unknown as typeof fetch;

            const result = await gateway.verifyWebhookAsync(
                { id: 'event-123' },
                {
                    ...validWebhookHeaders(),
                    'paypal-cert-url': 'https://evil.example.com/cert',
                }
            );

            expect(result).toBe(false);
            expect(fetchCount).toBe(0);
        });

        it('should reject non-HTTPS PayPal cert URLs before calling the verify API', async () => {
            let fetchCount = 0;
            globalThis.fetch = mock(async () => {
                fetchCount++;
                return createMockResponse({});
            }) as unknown as typeof fetch;

            const result = await gateway.verifyWebhookAsync(
                { id: 'event-123' },
                {
                    ...validWebhookHeaders(),
                    'paypal-cert-url': 'http://api.paypal.com/cert',
                }
            );

            expect(result).toBe(false);
            expect(fetchCount).toBe(0);
        });

        it('should soft-accept aged transmission_time and still call PayPal verify', async () => {
            const warnings: string[] = [];
            const warnGateway = new PayPalGateway(
                PAYPAL_TEST_CONFIG,
                hooksManager,
                captureLogger(warnings),
            );
            let verifyCalled = false;
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;
                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }
                if (url.includes('verify-webhook-signature')) {
                    verifyCalled = true;
                    return createMockResponse({ verification_status: 'SUCCESS' });
                }
                return createMockResponse({});
            }) as unknown as typeof fetch;

            const result = await warnGateway.verifyWebhookAsync(
                { id: 'event-123' },
                {
                    ...validWebhookHeaders(),
                    // Older than 15 minutes — soft path still verifies (post-outage retries)
                    'paypal-transmission-time': new Date(Date.now() - 16 * 60 * 1000).toISOString(),
                }
            );

            expect(result).toBe(true);
            expect(verifyCalled).toBe(true);
            expect(warnings.some((message) =>
                message.includes('transmission_time') && message.includes('aged'),
            )).toBe(true);
        });

        it('should reject unparseable transmission_time without calling PayPal', async () => {
            const warnings: string[] = [];
            const warnGateway = new PayPalGateway(
                PAYPAL_TEST_CONFIG,
                hooksManager,
                captureLogger(warnings),
            );
            let fetchCount = 0;
            globalThis.fetch = mock(async () => {
                fetchCount++;
                return createMockResponse({});
            }) as unknown as typeof fetch;

            const result = await warnGateway.verifyWebhookAsync(
                { id: 'event-123' },
                {
                    ...validWebhookHeaders(),
                    'paypal-transmission-time': 'not-a-date',
                }
            );

            expect(result).toBe(false);
            expect(fetchCount).toBe(0);
            expect(warnings.some((message) =>
                message.includes('transmission_time') && message.includes('unparseable'),
            )).toBe(true);
        });

        it('should call PayPal API and return true on SUCCESS', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                return createMockResponse({ verification_status: 'SUCCESS' });
            }) as unknown as typeof fetch;

            const result = await gateway.verifyWebhookAsync(
                { id: 'event-123', event_type: 'PAYMENT.CAPTURE.COMPLETED' },
                validWebhookHeaders()
            );

            expect(result).toBe(true);
        });

        it('should embed raw string webhook_event without re-serializing key order', async () => {
            let rawVerifyBody: string | null = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('verify-webhook-signature') && init?.body) {
                    rawVerifyBody = init.body as string;
                }

                return createMockResponse({ verification_status: 'SUCCESS' });
            }) as unknown as typeof fetch;

            // Non-alphabetical key order + spacing that stringify would normalize away
            const rawJson =
                '{"z_key":1,"id":"event-string","event_type":"PAYMENT.CAPTURE.COMPLETED","a_key":2}';
            const result = await gateway.verifyWebhookAsync(
                rawJson,
                validWebhookHeaders()
            );

            expect(result).toBe(true);
            expect(rawVerifyBody).not.toBeNull();
            // Original substring must appear after "webhook_event": (no re-parse/stringify)
            expect(rawVerifyBody!).toContain('"webhook_event":' + rawJson);
            const parsed = JSON.parse(rawVerifyBody!);
            expect(parsed.webhook_event).toEqual({
                z_key: 1,
                id: 'event-string',
                event_type: 'PAYMENT.CAPTURE.COMPLETED',
                a_key: 2,
            });
        });

        it('should embed Buffer payload webhook_event as original JSON text', async () => {
            let rawVerifyBody: string | null = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('verify-webhook-signature') && init?.body) {
                    rawVerifyBody = init.body as string;
                }

                return createMockResponse({ verification_status: 'SUCCESS' });
            }) as unknown as typeof fetch;

            const rawJson =
                '{"id":"event-buffer","event_type":"PAYMENT.CAPTURE.COMPLETED","zz":true}';
            const result = await gateway.verifyWebhookAsync(
                Buffer.from(rawJson, 'utf8'),
                validWebhookHeaders()
            );

            expect(result).toBe(true);
            expect(rawVerifyBody).toContain('"webhook_event":' + rawJson);
        });

        it('should embed raw body with trailing newline as exact untrimmed text', async () => {
            let rawVerifyBody: string | null = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('verify-webhook-signature') && init?.body) {
                    rawVerifyBody = init.body as string;
                }

                return createMockResponse({ verification_status: 'SUCCESS' });
            }) as unknown as typeof fetch;

            // Trailing newline is common from HTTP bodies; must not be stripped from embed.
            const rawJson =
                '{"id":"event-newline","event_type":"PAYMENT.CAPTURE.COMPLETED"}\n';
            const result = await gateway.verifyWebhookAsync(
                rawJson,
                validWebhookHeaders()
            );

            expect(result).toBe(true);
            expect(rawVerifyBody).not.toBeNull();
            expect(rawVerifyBody!).toContain('"webhook_event":' + rawJson);
            // Ensure we did not trim the trailing newline away before embed
            expect(rawVerifyBody!).toContain(
                '"webhook_event":{"id":"event-newline","event_type":"PAYMENT.CAPTURE.COMPLETED"}\n}',
            );
        });

        it('should warn when verifying with an already-parsed object payload', async () => {
            const warnings: string[] = [];
            const warnGateway = new PayPalGateway(
                PAYPAL_TEST_CONFIG,
                hooksManager,
                captureLogger(warnings),
            );

            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                return createMockResponse({ verification_status: 'SUCCESS' });
            }) as unknown as typeof fetch;

            const result = await warnGateway.verifyWebhookAsync(
                { id: 'event-object', event_type: 'PAYMENT.CAPTURE.COMPLETED' },
                validWebhookHeaders()
            );

            expect(result).toBe(true);
            expect(warnings.some((message) =>
                message.includes('parsed object') && message.includes('re-serializes'),
            )).toBe(true);
        });

        it('should return false for invalid JSON string payloads without calling PayPal', async () => {
            let fetchCount = 0;
            globalThis.fetch = mock(async () => {
                fetchCount++;
                return createMockResponse({});
            }) as unknown as typeof fetch;

            const result = await gateway.verifyWebhookAsync(
                '{not-json',
                validWebhookHeaders()
            );

            expect(result).toBe(false);
            expect(fetchCount).toBe(0);
        });

        it('should return false on FAILURE verification status', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                return createMockResponse({ verification_status: 'FAILURE' });
            }) as unknown as typeof fetch;

            const result = await gateway.verifyWebhookAsync(
                { id: 'event-123' },
                validWebhookHeaders()
            );

            expect(result).toBe(false);
        });

        it('should throw when PayPal verification API is unavailable', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                return createMockResponse(
                    {
                        name: 'INTERNAL_SERVER_ERROR',
                        message: 'Temporary PayPal outage',
                    },
                    false,
                    500
                );
            }) as unknown as typeof fetch;

            await expect(
                gateway.verifyWebhookAsync(
                    { id: 'event-123' },
                    validWebhookHeaders()
                )
            ).rejects.toThrow(GatewayApiError);
        });

        it('should throw NetworkError when webhook verification cannot reach PayPal', async () => {
            let fetchCount = 0;
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                fetchCount++;
                throw new TypeError('fetch failed');
            }) as unknown as typeof fetch;

            await expect(
                gateway.verifyWebhookAsync(
                    { id: 'event-123' },
                    validWebhookHeaders()
                )
            ).rejects.toThrow(NetworkError);
            expect(fetchCount).toBe(3);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Webhook Parsing Tests
    // ═══════════════════════════════════════════════════════════════════════════

    describe('parseWebhookEvent', () => {
        it('should parse PAYMENT.CAPTURE.COMPLETED event', () => {
            const payload = {
                id: 'WH-event-123',
                event_type: 'PAYMENT.CAPTURE.COMPLETED',
                create_time: '2024-06-15T14:30:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'capture-abc123',
                    status: 'COMPLETED',
                    final_capture: true,
                    amount: {
                        currency_code: 'USD',
                        value: '99.99',
                    },
                    custom_id: 'internal_payment_001',
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.id).toBe('WH-event-123');
            expect(event.type).toBe('PAYMENT.CAPTURE.COMPLETED');
            expect(event.gateway).toBe('paypal');
            expect(event.gatewayPaymentId).toBe('capture-abc123');
            expect(event.paymentId).toBe('internal_payment_001');
            expect(event.status).toBe('paid');
            expect(moneyToMajorNumber(event.amount!)).toBe(99.99);
            expect(event.currency).toBe('USD');
            expect(event.timestamp).toBeInstanceOf(Date);
            expect(event.rawPayload).toEqual(payload);
        });

        it('P22-PP-DISPUTE: CUSTOMER.DISPUTE.CREATED dual-writes dispute.opened (not payment.succeeded, not throw)', () => {
            const payload = {
                id: 'WH-dispute-456',
                event_type: 'CUSTOMER.DISPUTE.CREATED',
                create_time: '2024-06-15T15:00:00Z',
                resource_type: 'dispute',
                resource: {
                    id: 'dispute-xyz789',
                    status: 'PENDING',
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.id).toBe('WH-dispute-456');
            expect(event.type).toBe('CUSTOMER.DISPUTE.CREATED');
            expect(event.gateway).toBe('paypal');
            expect(event.gatewayPaymentId).toBe('dispute-xyz789');
            expect(event.gatewayObjectId).toBe('dispute-xyz789');
            expect(event.status).not.toBe('paid');
            expect(event.status).not.toBe('pending');
            expect(event.stableType).toBe('dispute.opened');
            expect(event.stableType).not.toBe('payment.succeeded');
            expect(event.event?.type).toBe('dispute.opened');
            expect(event.event?.type).not.toBe('payment.succeeded');
            if (event.event?.type === 'dispute.opened') {
                expect(event.event.dispute.status).toBe('needs_response');
                expect(event.event.dispute.references.providerObjectId).toBe(
                    'dispute-xyz789',
                );
            }
            expect(isPaidOutcome({
                success: true,
                gatewayId: event.gatewayPaymentId,
                status: event.status,
                rawResponse: {},
            })).toBe(false);
        });

        it('P22-PP-DISPUTE: CUSTOMER.DISPUTE.UPDATED / RESOLVED parse as dispute lifecycle dual-write', () => {
            const updated = gateway.parseWebhookEvent({
                id: 'WH-dispute-updated',
                event_type: 'CUSTOMER.DISPUTE.UPDATED',
                create_time: '2024-06-15T15:00:00Z',
                resource_type: 'dispute',
                resource: {
                    id: 'dispute-updated-1',
                    status: 'UNDER_REVIEW',
                },
            });
            expect(updated.status).toBe('under_review');
            expect(updated.status).not.toBe('pending');
            expect(updated.status).not.toBe('paid');
            expect(updated.stableType).toBe('dispute.updated');
            expect(updated.event?.type).toBe('dispute.updated');
            expect(updated.gatewayPaymentId).toBe('dispute-updated-1');
            expect(updated.gatewayObjectId).toBe('dispute-updated-1');

            const won = gateway.parseWebhookEvent({
                id: 'WH-dispute-resolved-won',
                event_type: 'CUSTOMER.DISPUTE.RESOLVED',
                create_time: '2024-06-15T15:00:00Z',
                resource_type: 'dispute',
                resource: {
                    id: 'dispute-won-1',
                    status: 'RESOLVED',
                    dispute_outcome: { outcome_code: 'RESOLVED_SELLER' },
                },
            });
            expect(won.status).toBe('won');
            expect(won.status).not.toBe('paid');
            expect(won.stableType).toBe('dispute.closed');
            expect(won.event?.type).toBe('dispute.closed');
            expect(won.gatewayPaymentId).toBe('dispute-won-1');
            expect(won.gatewayObjectId).toBe('dispute-won-1');

            const lost = gateway.parseWebhookEvent({
                id: 'WH-dispute-resolved-lost',
                event_type: 'CUSTOMER.DISPUTE.RESOLVED',
                create_time: '2024-06-15T15:00:00Z',
                resource_type: 'dispute',
                resource: {
                    id: 'dispute-lost-1',
                    status: 'RESOLVED',
                    dispute_outcome: { outcome_code: 'RESOLVED_BUYER' },
                },
            });
            expect(lost.status).toBe('lost');
            expect(lost.stableType).toBe('dispute.closed');
            expect(lost.gatewayPaymentId).toBe('dispute-lost-1');
        });

        it('P22-PP-DISPUTE: OPEN dispute maps to needs_response, never paid', () => {
            const event = gateway.parseWebhookEvent({
                id: 'WH-dispute-open',
                event_type: 'CUSTOMER.DISPUTE.CREATED',
                create_time: '2024-06-15T15:00:00Z',
                resource_type: 'dispute',
                resource: {
                    id: 'PP-D-OPEN',
                    status: 'OPEN',
                },
            });
            expect(event.status).toBe('needs_response');
            expect(event.status).not.toBe('paid');
            expect(event.status).not.toBe('pending');
            expect(event.stableType).toBe('dispute.opened');
            expect(event.gatewayPaymentId).toBe('PP-D-OPEN');
            expect(event.gatewayObjectId).toBe('PP-D-OPEN');
        });

        it('should reject unsupported unknown event types instead of mapping them to pending USD 0', () => {
            const payload = {
                id: 'WH-billing-456',
                event_type: 'BILLING.SUBSCRIPTION.CREATED',
                create_time: '2024-06-15T15:00:00Z',
                resource_type: 'subscription',
                resource: {
                    id: 'I-SUB123',
                    status: 'ACTIVE',
                },
            };

            expect(() => gateway.parseWebhookEvent(payload)).toThrow(InvalidRequestError);
        });

        it('should extract capture ID from supplementary_data', () => {
            const payload = {
                id: 'WH-order-789',
                event_type: 'CHECKOUT.ORDER.COMPLETED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-123',
                    status: 'COMPLETED',
                    supplementary_data: {
                        related_ids: {
                            capture_id: 'capture-from-supplementary',
                        },
                    },
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '10.00',
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.gatewayPaymentId).toBe('capture-from-supplementary');
            // PAYPAL-3: a capture_id string is not settlement evidence.
            expect(event.status).toBe('processing');
            expect(event.status).not.toBe('paid');
            expect(event.stableType).not.toBe('payment.succeeded');
            expect(isPaidOutcome({
                success: true,
                gatewayId: event.gatewayPaymentId ?? 'order-123',
                status: event.status,
                rawResponse: {},
            })).toBe(false);
        });

        it('ORDER.COMPLETED + capture_id only (no nested captures) is not paid (PAYPAL-3)', () => {
            const event = gateway.parseWebhookEvent({
                id: 'WH-order-capture-id-only',
                event_type: 'CHECKOUT.ORDER.COMPLETED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-capture-id-only',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '25.00',
                    },
                    supplementary_data: {
                        related_ids: {
                            capture_id: 'CAPTURE-ID-ONLY',
                        },
                    },
                },
            });

            expect(event.status).toBe('processing');
            expect(event.status).not.toBe('paid');
            expect(event.gatewayPaymentId).toBe('CAPTURE-ID-ONLY');
            expect(event.stableType).not.toBe('payment.succeeded');
            expect(isPaidOutcome({
                success: true,
                gatewayId: event.gatewayPaymentId ?? 'order-capture-id-only',
                status: event.status,
                rawResponse: {},
            })).toBe(false);
        });

        it('should aggregate multi-capture amounts on ORDER.COMPLETED webhooks (PAYPAL-5)', () => {
            const payload = {
                id: 'WH-multi-capture',
                event_type: 'CHECKOUT.ORDER.COMPLETED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-multi',
                    status: 'COMPLETED',
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '100.00',
                            },
                            payments: {
                                captures: [
                                    {
                                        id: 'CAPTURE-FIRST',
                                        status: 'COMPLETED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '40.00',
                                        },
                                    },
                                    {
                                        id: 'CAPTURE-LAST',
                                        status: 'COMPLETED',
                                        final_capture: true,
                                        amount: {
                                            currency_code: 'USD',
                                            value: '60.00',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            // PAYPAL-1: multi-capture uses order id, not latest capture + full aggregate amount.
            expect(event.gatewayPaymentId).toBe('order-multi');
            expect(event.gatewayPaymentId).not.toBe('CAPTURE-LAST');
            expect(moneyToMajorNumber(event.amount!)).toBe(100);
            expect(event.status).toBe('paid');
            expect(isPaidOutcome({
                success: true,
                gatewayId: event.gatewayPaymentId ?? 'order-multi',
                status: event.status,
                rawResponse: {},
            })).toBe(true);
        });

        it('should aggregate multi-capture amount by create_time order without single capture id (PAYPAL-1)', () => {
            const payload = {
                id: 'WH-multi-capture-times',
                event_type: 'CHECKOUT.ORDER.COMPLETED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-multi-times',
                    status: 'COMPLETED',
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '100.00',
                            },
                            payments: {
                                captures: [
                                    {
                                        id: 'CAPTURE-NEWER',
                                        status: 'COMPLETED',
                                        final_capture: true,
                                        create_time: '2024-06-15T18:00:00Z',
                                        update_time: '2024-06-15T18:30:00Z',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '40.00',
                                        },
                                    },
                                    {
                                        id: 'CAPTURE-OLDER-LAST-IN-ARRAY',
                                        status: 'COMPLETED',
                                        create_time: '2024-06-15T12:00:00Z',
                                        update_time: '2024-06-15T12:30:00Z',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '60.00',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            // Order id — not a single capture (would dual-write false full-refund target).
            expect(event.gatewayPaymentId).toBe('order-multi-times');
            expect(event.gatewayPaymentId).not.toBe('CAPTURE-NEWER');
            expect(event.gatewayPaymentId).not.toBe('CAPTURE-OLDER-LAST-IN-ARRAY');
            // Aggregate 40+60, not last-by-time slice 40 alone
            expect(moneyToMajorNumber(event.amount!)).toBe(100);
            expect(event.status).toBe('paid');
        });

        it('ORDER multi-capture with one REFUNDED sibling → partially_refunded, excludes refunded face (PAYPAL-2)', () => {
            const payload = {
                id: 'WH-multi-capture-partial-refund',
                event_type: 'CHECKOUT.ORDER.COMPLETED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-multi-refunded-slice',
                    status: 'COMPLETED',
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '100.00',
                            },
                            payments: {
                                captures: [
                                    {
                                        id: 'CAPTURE-REFUNDED-SLICE',
                                        status: 'REFUNDED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '40.00',
                                        },
                                    },
                                    {
                                        id: 'CAPTURE-STILL-HELD',
                                        status: 'COMPLETED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '60.00',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            // Not false paid; remaining held is 60 not 100.
            expect(event.status).toBe('partially_refunded');
            expect(event.status).not.toBe('paid');
            expect(moneyToMajorNumber(event.amount!)).toBe(60);
            expect(moneyToMajorNumber(event.amount!)).not.toBe(100);
            // Single refundable capture remains → capture id is honest refund target.
            expect(event.gatewayPaymentId).toBe('CAPTURE-STILL-HELD');
            expect(isPaidOutcome({
                success: true,
                gatewayId: event.gatewayPaymentId ?? 'order-multi-refunded-slice',
                status: event.status,
                rawResponse: {},
            })).toBe(false);
        });

        it('ORDER multi-capture last/related REFUNDED + one held sibling uses held capture id (PAYPAL-ID-1)', () => {
            const payload = {
                id: 'WH-multi-capture-held-not-last',
                event_type: 'CHECKOUT.ORDER.COMPLETED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-multi-held-not-last',
                    status: 'COMPLETED',
                    supplementary_data: {
                        related_ids: {
                            capture_id: 'CAPTURE-REFUNDED-LAST',
                        },
                    },
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '100.00',
                            },
                            payments: {
                                captures: [
                                    {
                                        id: 'CAPTURE-STILL-HELD',
                                        status: 'COMPLETED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '50.00',
                                        },
                                    },
                                    {
                                        id: 'CAPTURE-REFUNDED-LAST',
                                        status: 'REFUNDED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '50.00',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            // Remaining-held money must attach to the still-held capture, not
            // last / related_ids.capture_id (the already-refunded slice).
            expect(event.status).toBe('partially_refunded');
            expect(moneyToMajorNumber(event.amount!)).toBe(50);
            expect(event.gatewayPaymentId).toBe('CAPTURE-STILL-HELD');
            expect(event.gatewayPaymentId).not.toBe('CAPTURE-REFUNDED-LAST');
            expect(event.gatewayPaymentId).not.toBe('order-multi-held-not-last');
        });

        it('ORDER multi-capture two still-held siblings keeps order id (PAYPAL-ID-1)', () => {
            const payload = {
                id: 'WH-multi-capture-two-held',
                event_type: 'CHECKOUT.ORDER.COMPLETED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-two-held',
                    status: 'COMPLETED',
                    supplementary_data: {
                        related_ids: {
                            capture_id: 'CAPTURE-HELD-B',
                        },
                    },
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '100.00',
                            },
                            payments: {
                                captures: [
                                    {
                                        id: 'CAPTURE-HELD-A',
                                        status: 'COMPLETED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '50.00',
                                        },
                                    },
                                    {
                                        id: 'CAPTURE-HELD-B',
                                        status: 'COMPLETED',
                                        final_capture: true,
                                        amount: {
                                            currency_code: 'USD',
                                            value: '50.00',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.status).toBe('paid');
            expect(event.gatewayPaymentId).toBe('order-two-held');
            expect(event.gatewayPaymentId).not.toBe('CAPTURE-HELD-A');
            expect(event.gatewayPaymentId).not.toBe('CAPTURE-HELD-B');
        });

        it('CAPTURE.REFUNDED multi-capture related_ids refunded slice uses held capture (PAYPAL-ID-1)', () => {
            const event = gateway.parseWebhookEvent({
                id: 'WH-capture-refunded-siblings',
                event_type: 'PAYMENT.CAPTURE.REFUNDED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-capture-refunded-siblings',
                    status: 'COMPLETED',
                    supplementary_data: {
                        related_ids: {
                            capture_id: 'CAPTURE-REFUNDED-RELATED',
                        },
                    },
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '100.00',
                            },
                            payments: {
                                captures: [
                                    {
                                        id: 'CAPTURE-HELD-SIBLING',
                                        status: 'COMPLETED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '50.00',
                                        },
                                    },
                                    {
                                        id: 'CAPTURE-REFUNDED-RELATED',
                                        status: 'REFUNDED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '50.00',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            });

            expect(event.status).toBe('partially_refunded');
            expect(event.gatewayPaymentId).toBe('CAPTURE-HELD-SIBLING');
            expect(event.gatewayPaymentId).not.toBe('CAPTURE-REFUNDED-RELATED');
            expect(event.gatewayPaymentId).not.toBe('order-capture-refunded-siblings');
            expect(event.stableType).toBe('refund.pending');
            expect(event.event?.type).toBe('refund.pending');
        });

        it('ORDER multi-capture all REFUNDED → amount 0 remaining with currency (PAYPAL-5)', () => {
            const payload = {
                id: 'WH-multi-all-refunded',
                event_type: 'CHECKOUT.ORDER.COMPLETED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-all-refunded',
                    status: 'COMPLETED',
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '100.00',
                            },
                            payments: {
                                captures: [
                                    {
                                        id: 'CAP-R1',
                                        status: 'REFUNDED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '40.00',
                                        },
                                    },
                                    {
                                        id: 'CAP-R2',
                                        status: 'REFUNDED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '60.00',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.status).toBe('refunded');
            // Live zero remaining path (not dead formatAmount(0) catch).
            expect(moneyToMajorNumber(event.amount!, { allowZero: true })).toBe(0);
            expect(event.currency).toBe('USD');
        });

        it('ORDER.COMPLETED under-total multi-capture → partially_captured not paid (audit PAYPAL-2)', () => {
            const payload = {
                id: 'WH-order-under-total',
                event_type: 'CHECKOUT.ORDER.COMPLETED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-under',
                    status: 'COMPLETED',
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '100.00',
                            },
                            payments: {
                                captures: [
                                    {
                                        id: 'CAPTURE-PARTIAL-ONLY',
                                        status: 'COMPLETED',
                                        final_capture: false,
                                        amount: {
                                            currency_code: 'USD',
                                            value: '40.00',
                                        },
                                    },
                                ],
                                authorizations: [
                                    {
                                        id: 'AUTH-OPEN-WH',
                                        status: 'PARTIALLY_CAPTURED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '100.00',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.gatewayPaymentId).toBe('CAPTURE-PARTIAL-ONLY');
            expect(moneyToMajorNumber(event.amount!)).toBe(40);
            expect(event.status).toBe('partially_captured');
            expect(event.stableType).toBe('payment.processing');
            expect(event.stableType).not.toBe('payment.succeeded');
            expect(isPaidOutcome({
                success: true,
                gatewayId: event.gatewayPaymentId ?? 'order-under',
                status: event.status,
                rawResponse: {},
            })).toBe(false);
        });

        it('should map CHECKOUT.ORDER.COMPLETED auth-only to authorized (PAYPAL-2; not approved/paid)', () => {
            const payload = {
                id: 'WH-order-completed-no-capture',
                event_type: 'CHECKOUT.ORDER.COMPLETED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-auth-only',
                    status: 'COMPLETED',
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '25.00',
                            },
                            payments: {
                                authorizations: [
                                    {
                                        id: 'AUTH-ONLY',
                                        status: 'CREATED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '25.00',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            // Align with getPayment authorized hold — not buyer-approved, not paid.
            expect(event.status).toBe('authorized');
            expect(event.status).not.toBe('approved');
            expect(event.status).not.toBe('paid');
            expect(event.gatewayPaymentId).toBe('order-auth-only');
            expect(moneyToMajorNumber(event.amount!)).toBe(25);
            expect(isPaidOutcome({
                success: true,
                gatewayId: event.gatewayPaymentId ?? 'order-auth-only',
                status: event.status,
                rawResponse: {},
            })).toBe(false);
        });

        it('ORDER.COMPLETED matching totals without final_capture is not paid (NEW-PAYPAL-3)', () => {
            const payload = {
                id: 'WH-order-completed-omitted-final',
                event_type: 'CHECKOUT.ORDER.COMPLETED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-omitted-final',
                    status: 'COMPLETED',
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '40.00',
                            },
                            payments: {
                                captures: [
                                    {
                                        id: 'CAPTURE-OMITTED-FINAL',
                                        status: 'COMPLETED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '40.00',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.status).toBe('partially_captured');
            expect(event.status).not.toBe('paid');
            expect(event.stableType).toBe('payment.processing');
            expect(isPaidOutcome({
                success: true,
                gatewayId: event.gatewayPaymentId ?? 'order-omitted-final',
                status: event.status,
                rawResponse: {},
            })).toBe(false);
        });

        it('ORDER.COMPLETED without order/auth totals is not paid (NEW-PAYPAL-6)', () => {
            const payload = {
                id: 'WH-order-completed-no-totals',
                event_type: 'CHECKOUT.ORDER.COMPLETED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-no-totals',
                    status: 'COMPLETED',
                    purchase_units: [
                        {
                            payments: {
                                captures: [
                                    {
                                        id: 'CAPTURE-NO-TOTAL',
                                        status: 'COMPLETED',
                                        final_capture: true,
                                        amount: {
                                            currency_code: 'USD',
                                            value: '40.00',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.status).toBe('partially_captured');
            expect(event.status).not.toBe('paid');
            expect(event.stableType).toBe('payment.processing');
            expect(event.stableType).not.toBe('payment.succeeded');
            expect(isPaidOutcome({
                success: true,
                gatewayId: event.gatewayPaymentId ?? 'order-no-totals',
                status: event.status,
                rawResponse: {},
            })).toBe(false);
        });

        it('CHECKOUT.ORDER.COMPLETED bare (no captures/auth) is not paid (PAYPAL-1)', () => {
            const payload = {
                id: 'WH-order-completed-bare',
                event_type: 'CHECKOUT.ORDER.COMPLETED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-bare-completed',
                    status: 'COMPLETED',
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '30.00',
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.status).toBe('processing');
            expect(event.status).not.toBe('paid');
            expect(isPaidOutcome({
                success: true,
                gatewayId: event.gatewayPaymentId ?? 'order-bare-completed',
                status: event.status,
                rawResponse: {},
            })).toBe(false);
        });

        it('should use authorization resource id when AUTHORIZATION.CAPTURED has no capture id', () => {
            const payload = {
                id: 'WH-auth-captured',
                event_type: 'PAYMENT.AUTHORIZATION.CAPTURED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'authorization',
                resource: {
                    id: 'AUTH-NO-CAPTURE-LINK',
                    status: 'CAPTURED',
                    amount: {
                        currency_code: 'USD',
                        value: '50.00',
                    },
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            // Auth id is not refundable — callers must use a capture ID for refunds.
            // PAYPAL-5: dual-write payment.succeeded, not capture.completed (auth ≠ capture).
            expect(event.gatewayPaymentId).toBe('AUTH-NO-CAPTURE-LINK');
            expect(event.status).toBe('paid');
            expect(event.stableType).toBe('payment.succeeded');
            expect(event.stableType).not.toBe('capture.completed');
            expect(event.event?.type).toBe('payment.succeeded');
        });

        it('should extract custom_id from purchase_units', () => {
            const payload = {
                id: 'WH-order-101',
                event_type: 'CHECKOUT.ORDER.APPROVED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-456',
                    status: 'APPROVED',
                    purchase_units: [
                        {
                            custom_id: 'payment-from-purchase-unit',
                            amount: {
                                currency_code: 'USD',
                                value: '15.00',
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.paymentId).toBe('payment-from-purchase-unit');
        });

        it('should fall back to purchase unit reference_id when custom_id is not present', () => {
            const payload = {
                id: 'WH-order-reference',
                event_type: 'CHECKOUT.ORDER.APPROVED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-reference',
                    status: 'APPROVED',
                    purchase_units: [
                        {
                            reference_id: 'merchant-order-123',
                            amount: {
                                currency_code: 'USD',
                                value: '15.00',
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.paymentId).toBe('merchant-order-123');
        });

        it('should map CHECKOUT.ORDER.APPROVED using event type and extract order amount', () => {
            const payload = {
                id: 'WH-order-approved',
                event_type: 'CHECKOUT.ORDER.APPROVED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'ORDER-APPROVED',
                    status: 'APPROVED',
                    purchase_units: [
                        {
                            custom_id: 'payment-from-approved-order',
                            amount: {
                                currency_code: 'EUR',
                                value: '42.00',
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.status).toBe('approved');
            expect(moneyToMajorNumber(event.amount!)).toBe(42);
            expect(event.currency).toBe('EUR');
        });

        it('should parse CHECKOUT.PAYMENT-APPROVAL.REVERSED without resource id, status, or amount', () => {
            const payload = {
                id: 'WH-approval-reversed',
                create_time: '2024-06-15T17:00:00Z',
                event_type: 'CHECKOUT.PAYMENT-APPROVAL.REVERSED',
                resource_type: 'checkout-order',
                resource: {
                    order_id: 'ORDER-REVERSED',
                    purchase_units: [
                        {
                            reference_id: 'merchant-order-reversed',
                            custom_id: 'payment-reversed',
                        },
                    ],
                    payment_source: {
                        ideal: {
                            name: 'John Doe',
                            country_code: 'NL',
                        },
                    },
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.status).toBe('cancelled');
            expect(event.gatewayPaymentId).toBe('ORDER-REVERSED');
            expect(event.paymentId).toBe('payment-reversed');
            expect(event.amount).toBeUndefined();
            expect(event.currency).toBeUndefined();
        });

        it('should reject supported payment events that do not include amount data', () => {
            const payload = {
                id: 'WH-capture-missing-amount',
                event_type: 'PAYMENT.CAPTURE.COMPLETED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'CAPTURE-MISSING-AMOUNT',
                    status: 'COMPLETED',
                },
            };

            expect(() => gateway.parseWebhookEvent(payload)).toThrow(InvalidRequestError);
        });

        it('should map PAYMENT.REFUND.COMPLETED to refund_completed not full refunded (PAYPAL-2)', () => {
            // Refund resource amount is this-op only; without capture aggregate we
            // must not overstate payment status as fully refunded.
            const payload = {
                id: 'WH-refund-completed',
                event_type: 'PAYMENT.REFUND.COMPLETED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'refund',
                resource: {
                    id: 'REFUND-COMPLETED',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '5.00',
                    },
                    links: [
                        {
                            rel: 'up',
                            href: 'https://api-m.paypal.com/v2/payments/captures/CAPTURE-FOR-REFUND',
                            method: 'GET',
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.status).toBe('refund_completed');
            expect(event.status).not.toBe('refunded');
            expect(event.status).not.toBe('partially_refunded');
            expect(event.gatewayPaymentId).toBe('CAPTURE-FOR-REFUND');
            expect(event.gatewayObjectId).toBe('REFUND-COMPLETED');
            // Incomplete refund_completed must not dual-write refund.completed
            // (Stripe/Moyasar/Paymob). Provider-native type stays on the envelope.
            expect(event.type).toBe('PAYMENT.REFUND.COMPLETED');
            expect(event.stableType).toBe('refund.pending');
            expect(event.stableType).not.toBe('refund.completed');
            expect(event.event?.type).toBe('refund.pending');
            expect(event.provider?.eventType).toBe('PAYMENT.REFUND.COMPLETED');
            expect(moneyToMajorNumber(event.amount!)).toBe(5);
            expect(event.currency).toBe('USD');
        });

        it('should keep refund lifecycle webhooks distinct from payment failure state', () => {
            const payload = {
                id: 'WH-refund-pending',
                event_type: 'PAYMENT.REFUND.PENDING',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'refund',
                resource: {
                    id: 'REFUND-PENDING',
                    status: 'PENDING',
                    amount: {
                        currency_code: 'USD',
                        value: '5.00',
                    },
                    links: [
                        {
                            rel: 'up',
                            href: 'https://api-m.paypal.com/v2/payments/captures/CAPTURE-FOR-REFUND',
                            method: 'GET',
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.status).toBe('refund_pending');
            expect(event.gatewayPaymentId).toBe('CAPTURE-FOR-REFUND');
            expect(event.gatewayObjectId).toBe('REFUND-PENDING');
        });

        it('should map failed refund webhooks to refund_failed', () => {
            const payload = {
                id: 'WH-refund-failed',
                event_type: 'PAYMENT.REFUND.FAILED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'refund',
                resource: {
                    id: 'REFUND-FAILED',
                    status: 'FAILED',
                    amount: {
                        currency_code: 'USD',
                        value: '5.00',
                    },
                    supplementary_data: {
                        related_ids: {
                            capture_id: 'CAPTURE-FOR-FAILED-REFUND',
                        },
                    },
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.status).toBe('refund_failed');
            expect(event.gatewayPaymentId).toBe('CAPTURE-FOR-FAILED-REFUND');
            expect(event.gatewayObjectId).toBe('REFUND-FAILED');
        });

        it('should not use refund custom_id as the original payment ID', () => {
            const payload = {
                id: 'WH-refund-custom-id',
                event_type: 'PAYMENT.REFUND.PENDING',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'refund',
                resource: {
                    id: 'REFUND-WITH-CUSTOM-ID',
                    status: 'PENDING',
                    custom_id: 'refund-external-reference',
                    amount: {
                        currency_code: 'USD',
                        value: '5.00',
                    },
                    links: [
                        {
                            rel: 'up',
                            href: 'https://api-m.paypal.com/v2/payments/captures/CAPTURE-FOR-REFUND-CUSTOM',
                            method: 'GET',
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.paymentId).toBeUndefined();
            expect(event.gatewayPaymentId).toBe('CAPTURE-FOR-REFUND-CUSTOM');
            expect(event.gatewayObjectId).toBe('REFUND-WITH-CUSTOM-ID');
        });

        it('should map capture reversal webhooks distinctly from merchant refunds', () => {
            const payload = {
                id: 'WH-capture-reversed',
                event_type: 'PAYMENT.CAPTURE.REVERSED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'CAPTURE-REVERSED',
                    status: 'REVERSED',
                    amount: {
                        currency_code: 'USD',
                        value: '11.00',
                    },
                    custom_id: 'internal-payment-reversed',
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.status).toBe('reversed');
            expect(event.paymentId).toBe('internal-payment-reversed');
            expect(event.gatewayPaymentId).toBe('CAPTURE-REVERSED');
            // Audit PAYPAL-1: never publish original capture face as still-held after reverse.
            expect(moneyToMajorNumber(event.amount!, { allowZero: true })).toBe(0);
            expect(event.currency).toBe('USD');
        });

        it('CAPTURE.REFUNDED refund-resource COMPLETED partial amount is not full refunded (PAYPAL-1)', () => {
            const event = gateway.parseWebhookEvent({
                id: 'WH-capture-refunded-refund-resource',
                event_type: 'PAYMENT.CAPTURE.REFUNDED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'refund',
                resource: {
                    id: 'REFUND-SLICE',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '5.00',
                    },
                    supplementary_data: {
                        related_ids: {
                            capture_id: 'CAPTURE-FOR-SLICE-REFUND',
                        },
                    },
                },
            });

            expect(event.status).toBe('partially_refunded');
            expect(event.status).not.toBe('refunded');
            expect(event.status).not.toBe('paid');
            expect(event.gatewayPaymentId).toBe('CAPTURE-FOR-SLICE-REFUND');
            expect(event.gatewayObjectId).toBe('REFUND-SLICE');
            // This-op refund face is not remaining held — omit when capture totals unknown.
            expect(event.amount).toBeUndefined();
            expect(event.currency).toBeUndefined();
            // PAYPAL-DW-1: refund-shaped COMPLETED must not type-only settle.
            expect(event.type).toBe('PAYMENT.CAPTURE.REFUNDED');
            expect(event.stableType).toBe('refund.pending');
            expect(event.stableType).not.toBe('refund.completed');
            expect(event.event?.type).toBe('refund.pending');
            expect(event.event?.type).not.toBe('refund.completed');
            expect(event.provider?.eventType).toBe('PAYMENT.CAPTURE.REFUNDED');
        });

        it('CAPTURE.REFUNDED refund-resource COMPLETED is not type-only refund.completed (PAYPAL-DW-1)', () => {
            const event = gateway.parseWebhookEvent({
                id: 'WH-capture-refunded-type-only',
                event_type: 'PAYMENT.CAPTURE.REFUNDED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'refund',
                resource: {
                    id: 'REFUND-TYPE-ONLY',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '5.00',
                    },
                    supplementary_data: {
                        related_ids: {
                            capture_id: 'CAPTURE-TYPE-ONLY',
                        },
                    },
                },
            });

            expect(event.status).toBe('partially_refunded');
            expect(event.stableType).not.toBe('refund.completed');
            expect(event.event?.type).not.toBe('refund.completed');
            expect(event.stableType).toBe('refund.pending');
            expect(event.event?.type).toBe('refund.pending');
        });

        it('should preserve partially refunded capture webhook status', () => {
            const payload = {
                id: 'WH-capture-partially-refunded',
                event_type: 'PAYMENT.CAPTURE.REFUNDED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'CAPTURE-PARTIALLY-REFUNDED',
                    status: 'PARTIALLY_REFUNDED',
                    amount: {
                        currency_code: 'USD',
                        value: '11.00',
                    },
                    custom_id: 'internal-payment-partially-refunded',
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.status).toBe('partially_refunded');
            expect(event.paymentId).toBe('internal-payment-partially-refunded');
            expect(event.gatewayPaymentId).toBe('CAPTURE-PARTIALLY-REFUNDED');
            // Audit PAYPAL-2: face without net remaining → omit (not 11 still held).
            expect(event.amount).toBeUndefined();
            expect(event.currency).toBeUndefined();
            // Incomplete capture settlement must not type-only settle as refund.completed.
            expect(event.stableType).toBe('refund.pending');
            expect(event.event?.type).toBe('refund.pending');
        });

        it('CAPTURE.REFUNDED this-op COMPLETED with breakdown publishes remaining not face (NEW-PAYPAL-4)', () => {
            const event = gateway.parseWebhookEvent({
                id: 'WH-capture-refunded-completed-breakdown',
                event_type: 'PAYMENT.CAPTURE.REFUNDED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'CAPTURE-COMPLETED-THIS-OP',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '100.00',
                    },
                    seller_receivable_breakdown: {
                        total_refunded_amount: {
                            currency_code: 'USD',
                            value: '30.00',
                        },
                    },
                },
            });

            expect(event.status).toBe('partially_refunded');
            expect(moneyToMajorNumber(event.amount!)).toBe(70);
            expect(moneyToMajorNumber(event.amount!)).not.toBe(100);
            expect(event.currency).toBe('USD');
        });

        it('CAPTURE.REFUNDED this-op COMPLETED without remaining-held omits face (NEW-PAYPAL-4)', () => {
            const event = gateway.parseWebhookEvent({
                id: 'WH-capture-refunded-completed-face',
                event_type: 'PAYMENT.CAPTURE.REFUNDED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'CAPTURE-COMPLETED-FACE',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '100.00',
                    },
                },
            });

            expect(event.status).toBe('partially_refunded');
            expect(event.amount).toBeUndefined();
            expect(event.currency).toBeUndefined();
        });

        it('CAPTURE.REFUNDED order-shaped COMPLETED does not publish order face (NEW-PAYPAL-4)', () => {
            const event = gateway.parseWebhookEvent({
                id: 'WH-capture-refunded-order-shaped',
                event_type: 'PAYMENT.CAPTURE.REFUNDED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-refunded-shaped',
                    status: 'COMPLETED',
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '100.00',
                            },
                        },
                    ],
                },
            });

            expect(event.status).toBe('partially_refunded');
            expect(event.amount).toBeUndefined();
        });

        it('CAPTURE.REVERSED this-op COMPLETED publishes 0 remaining not face (NEW-PAYPAL-4)', () => {
            const event = gateway.parseWebhookEvent({
                id: 'WH-capture-reversed-completed',
                event_type: 'PAYMENT.CAPTURE.REVERSED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'CAPTURE-REVERSED-COMPLETED',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '88.00',
                    },
                },
            });

            expect(event.status).toBe('reversed');
            expect(moneyToMajorNumber(event.amount!, { allowZero: true })).toBe(0);
            expect(moneyToMajorNumber(event.amount!, { allowZero: true })).not.toBe(88);
            expect(event.currency).toBe('USD');
        });

        it('CAPTURE.REFUNDED fully refunded publishes 0 remaining not face (audit PAYPAL-2)', () => {
            const event = gateway.parseWebhookEvent({
                id: 'WH-capture-fully-refunded',
                event_type: 'PAYMENT.CAPTURE.REFUNDED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'CAPTURE-FULLY-REFUNDED',
                    status: 'REFUNDED',
                    amount: {
                        currency_code: 'USD',
                        value: '50.00',
                    },
                    custom_id: 'internal-full-refund',
                },
            });

            expect(event.status).toBe('refunded');
            expect(moneyToMajorNumber(event.amount!, { allowZero: true })).toBe(0);
            expect(event.currency).toBe('USD');
            expect(event.stableType).toBe('refund.completed');
        });

        it('CAPTURE.REFUNDED partial with breakdown publishes net remaining (audit PAYPAL-2)', () => {
            const event = gateway.parseWebhookEvent({
                id: 'WH-capture-partial-net',
                event_type: 'PAYMENT.CAPTURE.REFUNDED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'CAPTURE-PARTIAL-NET',
                    status: 'PARTIALLY_REFUNDED',
                    amount: {
                        currency_code: 'USD',
                        value: '100.00',
                    },
                    seller_receivable_breakdown: {
                        total_refunded_amount: {
                            currency_code: 'USD',
                            value: '40.00',
                        },
                    },
                    custom_id: 'internal-partial-net',
                },
            });

            expect(event.status).toBe('partially_refunded');
            expect(moneyToMajorNumber(event.amount!)).toBe(60);
            expect(event.currency).toBe('USD');
        });

        it('CAPTURE.REFUNDED remaining held is exact on bigint minors (PAYPAL-2 float trap)', () => {
            // Classic binary-float traps: 0.30-0.20 and 1.03-0.42 must not ULP-drift.
            const event = gateway.parseWebhookEvent({
                id: 'WH-capture-bigint-remaining',
                event_type: 'PAYMENT.CAPTURE.REFUNDED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'CAPTURE-BIGINT-REMAINING',
                    status: 'PARTIALLY_REFUNDED',
                    amount: {
                        currency_code: 'USD',
                        value: '0.30',
                    },
                    seller_receivable_breakdown: {
                        total_refunded_amount: {
                            currency_code: 'USD',
                            value: '0.20',
                        },
                    },
                },
            });

            expect(event.status).toBe('partially_refunded');
            expect(moneyToMajorNumber(event.amount!)).toBe(0.1);
            expect(event.currency).toBe('USD');
            // Not a float residue (e.g. 0.09999999999999998).
            expect(Object.is(moneyToMajorNumber(event.amount!), 0.1)).toBe(true);
        });

        it('CAPTURE.REFUNDED face equals total_refunded → exact zero remaining omit path (PAYPAL-2)', () => {
            const event = gateway.parseWebhookEvent({
                id: 'WH-capture-exact-zero-remaining',
                event_type: 'PAYMENT.CAPTURE.REFUNDED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'CAPTURE-EXACT-ZERO',
                    status: 'PARTIALLY_REFUNDED',
                    amount: {
                        currency_code: 'USD',
                        value: '10.00',
                    },
                    seller_receivable_breakdown: {
                        total_refunded_amount: {
                            currency_code: 'USD',
                            value: '10.00',
                        },
                    },
                },
            });

            // remainingMinor === 0n → no still-held funds (omit face; full path may use 0).
            expect(event.status).toBe('partially_refunded');
            // Zero remaining: either omit or publish 0 — never original face 10.
            if (event.amount !== undefined) {
                expect(moneyToMajorNumber(event.amount!, { allowZero: true })).toBe(0);
                expect(moneyToMajorNumber(event.amount!, { allowZero: true })).not.toBe(10);
            }
        });

        it('CAPTURE.REFUNDED KWD 3-decimal remaining held is honest (PAYPAL-2)', () => {
            const event = gateway.parseWebhookEvent({
                id: 'WH-capture-kwd-remaining',
                event_type: 'PAYMENT.CAPTURE.REFUNDED',
                create_time: '2024-06-15T17:00:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'CAPTURE-KWD-REMAINING',
                    status: 'PARTIALLY_REFUNDED',
                    amount: {
                        currency_code: 'KWD',
                        value: '1.005',
                    },
                    seller_receivable_breakdown: {
                        total_refunded_amount: {
                            currency_code: 'KWD',
                            value: '0.500',
                        },
                    },
                },
            });

            expect(event.status).toBe('partially_refunded');
            expect(moneyToMajorNumber(event.amount!)).toBe(0.505);
            expect(event.currency).toBe('KWD');
        });

        it('ORDER multi-capture REFUNDED + PENDING sibling → partially_refunded (PAYPAL-3)', () => {
            const payload = {
                id: 'WH-multi-refunded-pending',
                event_type: 'CHECKOUT.ORDER.COMPLETED',
                create_time: '2024-06-15T16:00:00Z',
                resource_type: 'checkout-order',
                resource: {
                    id: 'order-refunded-pending',
                    status: 'COMPLETED',
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '100.00',
                            },
                            payments: {
                                captures: [
                                    {
                                        id: 'CAPTURE-REFUNDED-DONE',
                                        status: 'REFUNDED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '40.00',
                                        },
                                    },
                                    {
                                        id: 'CAPTURE-STILL-PENDING',
                                        status: 'PENDING',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '60.00',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            // PENDING is an open money path — must not claim full refunded.
            expect(event.status).toBe('partially_refunded');
            expect(event.status).not.toBe('refunded');
            // Incomplete snapshot: omit amount (do not publish REFUNDED/PENDING face).
            expect(event.amount).toBeUndefined();
            expect(isPaidOutcome({
                success: true,
                gatewayId: event.gatewayPaymentId ?? 'order-refunded-pending',
                status: event.status,
                rawResponse: {},
            })).toBe(false);
        });

        it('should throw error for invalid payload (missing id)', () => {
            expect(() => {
                gateway.parseWebhookEvent({ event_type: 'TEST' });
            }).toThrow(GatewayApiError);
        });

        it('should throw error for invalid payload (missing event_type)', () => {
            expect(() => {
                gateway.parseWebhookEvent({ id: 'test-123' });
            }).toThrow(GatewayApiError);
        });

        it('should throw error for invalid payload (missing resource)', () => {
            expect(() => {
                gateway.parseWebhookEvent({ id: 'test-123', event_type: 'TEST' });
            }).toThrow(GatewayApiError);
        });

        it('should throw error for non-object payload', () => {
            expect(() => {
                gateway.parseWebhookEvent('invalid');
            }).toThrow(GatewayApiError);

            expect(() => {
                gateway.parseWebhookEvent(null);
            }).toThrow(GatewayApiError);
        });

        it('should parse string and Buffer JSON payloads', () => {
            const payload = {
                id: 'WH-event-raw',
                event_type: 'PAYMENT.CAPTURE.COMPLETED',
                create_time: '2024-06-15T14:30:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'capture-raw',
                    status: 'COMPLETED',
                    final_capture: true,
                    amount: {
                        currency_code: 'USD',
                        value: '9.99',
                    },
                },
            };

            const fromString = gateway.parseWebhookEvent(JSON.stringify(payload));
            expect(fromString.gatewayPaymentId).toBe('capture-raw');
            expect(fromString.status).toBe('paid');

            const fromBuffer = gateway.parseWebhookEvent(
                Buffer.from(JSON.stringify(payload), 'utf8'),
            );
            expect(fromBuffer.gatewayPaymentId).toBe('capture-raw');
            expect(fromBuffer.status).toBe('paid');
        });

        it('Phase 7 dual-write: PAYMENT.CAPTURE.COMPLETED → capture.completed (not payment.succeeded)', () => {
            const payload = {
                id: 'WH-phase7-capture',
                event_type: 'PAYMENT.CAPTURE.COMPLETED',
                create_time: '2024-06-15T14:30:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'capture-phase7',
                    status: 'COMPLETED',
                    final_capture: true,
                    amount: {
                        currency_code: 'USD',
                        value: '99.99',
                    },
                    custom_id: 'internal_payment_001',
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.type).toBe('PAYMENT.CAPTURE.COMPLETED');
            expect(event.status).toBe('paid');
            expect(event.schemaVersion).toBe('1');
            expect(event.stableType).toBe('capture.completed');
            expect(event.event?.schemaVersion).toBe('1');
            expect(event.event?.type).toBe('capture.completed');
            expect(event.provider?.eventType).toBe('PAYMENT.CAPTURE.COMPLETED');
            expect(event.provider?.occurredAt).toBe('2024-06-15T14:30:00.000Z');
            expect(event.payloadHash).toBeDefined();
            // NEW-PERF-1: compact identity, not the full capture tree.
            expect(event.payloadHash).toBe(
                hashWebhookPayload({
                    id: 'WH-phase7-capture',
                    type: 'PAYMENT.CAPTURE.COMPLETED',
                    create_time: '2024-06-15T14:30:00Z',
                    resource: 'capture-phase7',
                }),
            );
            expect(event.payloadHash).not.toBe(hashWebhookPayload(event.rawPayload));

            const envelope = toPersistedPaymentEventEnvelope(event.event!, {
                payloadHash: event.payloadHash,
            });
            assertNoSecretsInEnvelope(envelope);
        });

        it('payloadHash is compact identity not full raw tree (NEW-PERF-1)', () => {
            const identity = {
                id: 'WH-hash-compact',
                event_type: 'PAYMENT.CAPTURE.COMPLETED',
                create_time: '2024-06-15T14:30:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'capture-hash-compact',
                    status: 'COMPLETED',
                    final_capture: true,
                    amount: {
                        currency_code: 'USD',
                        value: '1.00',
                    },
                },
            };
            const bloated = {
                ...identity,
                resource: {
                    ...identity.resource,
                    custom_id: 'internal_hash_bloat',
                    seller_receivable_breakdown: {
                        gross_amount: { currency_code: 'USD', value: '1.00' },
                        net_amount: { currency_code: 'USD', value: '0.70' },
                        paypal_fee: { currency_code: 'USD', value: '0.30' },
                    },
                },
            };

            const compactEvent = gateway.parseWebhookEvent(identity);
            const bloatedEvent = gateway.parseWebhookEvent(bloated);
            const expected = hashWebhookPayload({
                id: identity.id,
                type: identity.event_type,
                create_time: identity.create_time,
                resource: identity.resource.id,
            });

            expect(compactEvent.payloadHash).toBe(expected);
            expect(bloatedEvent.payloadHash).toBe(expected);
            // Inbox claim must use event.payloadHash; re-hashing rawPayload is a different digest.
            expect(compactEvent.payloadHash).not.toBe(
                hashWebhookPayload(compactEvent.rawPayload),
            );
            expect(bloatedEvent.payloadHash).not.toBe(
                hashWebhookPayload(bloatedEvent.rawPayload),
            );
        });

        it('Phase 7 dual-write: AUTHORIZATION.PARTIALLY_CAPTURED → payment.processing (not capture.completed)', () => {
            const payload = {
                id: 'WH-auth-partial-capture',
                event_type: 'PAYMENT.AUTHORIZATION.PARTIALLY_CAPTURED',
                create_time: '2024-06-15T14:30:00Z',
                resource_type: 'authorization',
                resource: {
                    id: 'AUTH-PARTIAL-1',
                    status: 'PARTIALLY_CAPTURED',
                    amount: {
                        currency_code: 'USD',
                        value: '100.00',
                    },
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.type).toBe('PAYMENT.AUTHORIZATION.PARTIALLY_CAPTURED');
            expect(event.status).toBe('partially_captured');
            expect(event.stableType).toBe('payment.processing');
            expect(event.stableType).not.toBe('capture.completed');
            expect(event.stableType).not.toBe('payment.succeeded');
            expect(event.event?.type).toBe('payment.processing');
            expect(isPaidOutcome({
                success: true,
                gatewayId: event.gatewayPaymentId ?? 'AUTH-PARTIAL-1',
                status: event.status,
                rawResponse: {},
            })).toBe(false);
        });

        it('PAYMENT.CAPTURE.COMPLETED with final_capture false → partially_captured (PAYPAL-3)', () => {
            const payload = {
                id: 'WH-capture-partial-final',
                event_type: 'PAYMENT.CAPTURE.COMPLETED',
                create_time: '2024-06-15T14:30:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'capture-non-final',
                    status: 'COMPLETED',
                    final_capture: false,
                    amount: {
                        currency_code: 'USD',
                        value: '20.00',
                    },
                    custom_id: 'internal_partial_cap',
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.type).toBe('PAYMENT.CAPTURE.COMPLETED');
            expect(event.status).toBe('partially_captured');
            expect(moneyToMajorNumber(event.amount!)).toBe(20);
            // Dual-write demoted so type-only fulfillment does not over-ship
            expect(event.stableType).toBe('payment.processing');
            expect(event.stableType).not.toBe('capture.completed');
            expect(event.event?.type).toBe('payment.processing');
            expect(isPaidOutcome({
                success: true,
                gatewayId: event.gatewayPaymentId ?? 'capture-non-final',
                status: event.status,
                rawResponse: {},
            })).toBe(false);
        });

        it('PAYMENT.CAPTURE.COMPLETED with final_capture true stays paid', () => {
            const payload = {
                id: 'WH-capture-final',
                event_type: 'PAYMENT.CAPTURE.COMPLETED',
                create_time: '2024-06-15T14:30:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'capture-final',
                    status: 'COMPLETED',
                    final_capture: true,
                    amount: {
                        currency_code: 'USD',
                        value: '99.99',
                    },
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.status).toBe('paid');
            expect(event.stableType).toBe('capture.completed');
        });

        it('PAYMENT.CAPTURE.COMPLETED without final_capture is not paid (NEW-PAYPAL-3)', () => {
            const payload = {
                id: 'WH-capture-omitted-final',
                event_type: 'PAYMENT.CAPTURE.COMPLETED',
                create_time: '2024-06-15T14:30:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'capture-omitted-final',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '20.00',
                    },
                },
            };

            const event = gateway.parseWebhookEvent(payload);

            expect(event.status).toBe('partially_captured');
            expect(event.status).not.toBe('paid');
            expect(event.stableType).toBe('payment.processing');
            expect(event.stableType).not.toBe('capture.completed');
            expect(isPaidOutcome({
                success: true,
                gatewayId: event.gatewayPaymentId ?? 'capture-omitted-final',
                status: event.status,
                rawResponse: {},
            })).toBe(false);
        });

        it('Phase 7 dual-write: refund events → refund.*', () => {
            const refunded = gateway.parseWebhookEvent({
                id: 'WH-refund-done',
                event_type: 'PAYMENT.CAPTURE.REFUNDED',
                create_time: '2024-06-15T14:30:00Z',
                resource_type: 'capture',
                resource: {
                    id: 'capture-refunded',
                    status: 'REFUNDED',
                    amount: {
                        currency_code: 'USD',
                        value: '10.00',
                    },
                },
            });
            expect(refunded.stableType).toBe('refund.completed');
            expect(refunded.event?.type).toBe('refund.completed');

            const refundPending = gateway.parseWebhookEvent({
                id: 'WH-refund-pending-p7',
                event_type: 'PAYMENT.REFUND.PENDING',
                create_time: '2024-06-15T14:30:00Z',
                resource_type: 'refund',
                resource: {
                    id: 'refund-1',
                    status: 'PENDING',
                    amount: {
                        currency_code: 'USD',
                        value: '5.00',
                    },
                    links: [
                        {
                            href: 'https://api.paypal.com/v2/payments/captures/cap-1',
                            rel: 'up',
                            method: 'GET',
                        },
                    ],
                },
            });
            expect(refundPending.stableType).toBe('refund.pending');
            expect(refundPending.event?.type).toBe('refund.pending');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Status Mapping Tests
    // ═══════════════════════════════════════════════════════════════════════════

    describe('Status Mapping', () => {
        const orderStatusMappings = [
            { paypal: 'CREATED', expected: 'pending' },
            { paypal: 'SAVED', expected: 'pending' },
            { paypal: 'APPROVED', expected: 'approved' },
            { paypal: 'VOIDED', expected: 'cancelled' },
            { paypal: 'COMPLETED', expected: 'paid' },
            { paypal: 'PAYER_ACTION_REQUIRED', expected: 'pending' },
            { paypal: 'UNKNOWN_STATUS', expected: 'pending' },
        ];

        for (const { paypal, expected } of orderStatusMappings) {
            it(`should map order status '${paypal}' to '${expected}'`, () => {
                const mapped = (gateway as any).mapStatus(paypal);
                expect(mapped).toBe(expected);
            });
        }

        it('should warn when mapping an unknown order status', () => {
            const warnings: string[] = [];
            const warnGateway = new PayPalGateway(
                PAYPAL_TEST_CONFIG,
                hooksManager,
                captureLogger(warnings),
            );

            const mapped = (warnGateway as any).mapStatus('UNKNOWN_STATUS');
            expect(mapped).toBe('pending');
            expect(warnings.some((message) => message.includes('Unmapped order status'))).toBe(true);
        });

        const resourceStatusMappings = [
            { paypal: 'CREATED', expected: 'authorized' },
            { paypal: 'COMPLETED', expected: 'paid' },
            { paypal: 'CAPTURED', expected: 'paid' },
            { paypal: 'PARTIALLY_CAPTURED', expected: 'partially_captured' },
            { paypal: 'DENIED', expected: 'failed' },
            { paypal: 'DECLINED', expected: 'failed' },
            { paypal: 'PARTIALLY_REFUNDED', expected: 'partially_refunded' },
            { paypal: 'PENDING', expected: 'pending' },
            { paypal: 'REFUNDED', expected: 'refunded' },
            { paypal: 'REVERSED', expected: 'reversed' },
            { paypal: 'FAILED', expected: 'failed' },
            { paypal: 'VOIDED', expected: 'cancelled' },
            { paypal: 'EXPIRED', expected: 'cancelled' },
            { paypal: 'UNKNOWN', expected: 'pending' },
        ];

        for (const { paypal, expected } of resourceStatusMappings) {
            it(`should map resource status '${paypal}' to '${expected}'`, () => {
                const mapped = (gateway as any).mapResourceStatus(paypal);
                expect(mapped).toBe(expected);
            });
        }

        it('should warn when mapping an unknown resource status', () => {
            const warnings: string[] = [];
            const warnGateway = new PayPalGateway(
                PAYPAL_TEST_CONFIG,
                hooksManager,
                captureLogger(warnings),
            );

            const mapped = (warnGateway as any).mapResourceStatus('UNKNOWN');
            expect(mapped).toBe('pending');
            expect(warnings.some((message) => message.includes('Unmapped resource status'))).toBe(true);
        });

        it('should map unknown terminal-looking resource statuses to failed (fail-closed)', () => {
            const warnings: string[] = [];
            const warnGateway = new PayPalGateway(
                PAYPAL_TEST_CONFIG,
                hooksManager,
                captureLogger(warnings),
            );

            const mapped = (warnGateway as any).mapResourceStatus('INSTRUMENT_DECLINED_STATE');
            expect(mapped).toBe('failed');
            expect(warnings.some((message) =>
                message.includes('Unmapped resource status') && message.includes('failed'),
            )).toBe(true);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Error Mapping Tests
    // ═══════════════════════════════════════════════════════════════════════════

    describe('Error Mapping', () => {
        it('should map CARD_EXPIRED to CardDeclinedError', async () => {
            globalThis.fetch = createMockFetch(
                {
                    name: 'UNPROCESSABLE_ENTITY',
                    message: 'The requested action could not be performed',
                    details: [
                        { issue: 'CARD_EXPIRED', description: 'The card is expired' },
                    ],
                },
                false,
                422
            );

            await expect(
                gateway.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com/callback',
                })
            ).rejects.toThrow(CardDeclinedError);
        });

        it('should map INSTRUMENT_DECLINED to CardDeclinedError', async () => {
            globalThis.fetch = createMockFetch(
                {
                    name: 'UNPROCESSABLE_ENTITY',
                    message: 'The requested action could not be performed',
                    details: [
                        { issue: 'INSTRUMENT_DECLINED', description: 'The instrument was declined' },
                    ],
                },
                false,
                422
            );

            await expect(
                gateway.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com/callback',
                })
            ).rejects.toThrow(CardDeclinedError);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Create Payment Tests
    // ═══════════════════════════════════════════════════════════════════════════

    describe('createPayment', () => {
        it('should create order with correct request body', async () => {
            let capturedBody: unknown = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (init?.body) {
                    capturedBody = JSON.parse(init.body as string);
                }

                return createMockResponse({
                    id: 'ORDER-123',
                    status: 'CREATED',
                    links: [
                        { rel: 'approve', href: 'https://paypal.com/approve/ORDER-123' },
                    ],
                });
            }) as unknown as typeof fetch;

            const params: CreatePaymentParams = {
                amount: money(99.99, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com/callback',
                orderId: 'order-001',
                description: 'Test payment',
                idempotencyKey: 'idem-key-123',
                metadata: { paymentId: 'pay-001' },
                paypalShippingPreference: 'NO_SHIPPING',
            };

            const result = await gateway.createPayment(params);

            expect(result.gatewayId).toBe('ORDER-123');
            expect(result.status).toBe('pending');
            expect(result.redirectUrl).toBe('https://paypal.com/approve/ORDER-123');
            // Phase 6: approval redirect is requires_action, never succeeded
            expect(result.outcome).toBe('requires_action');
            expect(result.outcome).not.toBe('succeeded');
            expect(result.references?.providerObjectId).toBe('ORDER-123');
            expect(result.references?.relatedIds?.orderId).toBe('ORDER-123');
            expect(result.references?.providerNativeStatus).toBe('CREATED');

            expect(capturedBody).toEqual({
                intent: 'CAPTURE',
                purchase_units: [
                    {
                        reference_id: 'order-001',
                        description: 'Test payment',
                        custom_id: 'pay-001',
                        amount: {
                            currency_code: 'USD',
                            value: '99.99',
                        },
                    },
                ],
                payment_source: {
                    paypal: {
                        experience_context: {
                            payment_method_preference: 'IMMEDIATE_PAYMENT_REQUIRED',
                            return_url: 'https://example.com/callback',
                            cancel_url: 'https://example.com/callback',
                            shipping_preference: 'NO_SHIPPING',
                            user_action: 'PAY_NOW',
                        },
                    },
                },
            });
        });

        it('should use returnUrl and cancelUrl when provided', async () => {
            let capturedBody: unknown = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (init?.body) {
                    capturedBody = JSON.parse(init.body as string);
                }

                return createMockResponse({
                    id: 'ORDER-RETURN-CANCEL',
                    status: 'CREATED',
                    links: [
                        { rel: 'payer-action', href: 'https://paypal.com/checkoutnow?token=ORDER-RETURN-CANCEL' },
                    ],
                });
            }) as unknown as typeof fetch;

            const result = await gateway.createPayment({
                amount: money(10, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com/callback',
                returnUrl: 'https://example.com/success',
                cancelUrl: 'https://example.com/cancel',
            });

            expect(result.outcome).toBe('requires_action');
            expect((capturedBody as any).payment_source.paypal.experience_context).toMatchObject({
                return_url: 'https://example.com/success',
                cancel_url: 'https://example.com/cancel',
                shipping_preference: 'NO_SHIPPING',
            });
        });

        it('should allow returnUrl-only create and use returnUrl for both return_url and cancel_url', async () => {
            let capturedBody: unknown = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (init?.body) {
                    capturedBody = JSON.parse(init.body as string);
                }

                return createMockResponse({
                    id: 'ORDER-RETURN-ONLY',
                    status: 'CREATED',
                    links: [
                        { rel: 'payer-action', href: 'https://paypal.com/checkoutnow?token=ORDER-RETURN-ONLY' },
                    ],
                });
            }) as unknown as typeof fetch;

            const result = await gateway.createPayment({
                amount: money(10, "USD"),
                currency: 'USD',
                returnUrl: 'https://example.com/return',
            } as CreatePaymentParams);

            expect(result.outcome).toBe('requires_action');
            expect((capturedBody as any).payment_source.paypal.experience_context).toMatchObject({
                return_url: 'https://example.com/return',
                cancel_url: 'https://example.com/return',
            });
        });

        it('should reject SET_PROVIDED_ADDRESS until shipping address params are supported', async () => {
            let fetchCount = 0;
            globalThis.fetch = mock(async () => {
                fetchCount++;
                return createMockResponse({});
            }) as unknown as typeof fetch;

            await expect(
                gateway.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com/callback',
                    paypalShippingPreference: 'SET_PROVIDED_ADDRESS',
                }),
            ).rejects.toThrow(InvalidRequestError);

            await expect(
                gateway.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com/callback',
                    paypalShippingPreference: 'SET_PROVIDED_ADDRESS',
                }),
            ).rejects.toThrow(/SET_PROVIDED_ADDRESS is not supported/);

            expect(fetchCount).toBe(0);
        });

        it('should include PayPal-Request-Id header for idempotency', async () => {
            let capturedHeaders: Record<string, string> | null = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                // Capture headers from checkout/orders request
                if (url.includes('checkout/orders') && init?.headers) {
                    capturedHeaders = init.headers as Record<string, string>;
                }

                return createMockResponse({
                    id: 'ORDER-456',
                    status: 'CREATED',
                    links: [
                        { rel: 'payer-action', href: 'https://paypal.com/checkoutnow?token=ORDER-456' },
                    ],
                });
            }) as unknown as typeof fetch;

            await gateway.createPayment({
                amount: money(50, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com/callback',
                idempotencyKey: 'unique-key-abc',
            });

            expect(capturedHeaders).not.toBeNull();
            expect(capturedHeaders!['PayPal-Request-Id']).toBe('unique-key-abc');
        });

        it('trims idempotencyKey before sending PayPal-Request-Id (PAYPAL-IDEM-1)', async () => {
            let capturedHeaders: Record<string, string> | null = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('checkout/orders') && init?.headers) {
                    capturedHeaders = init.headers as Record<string, string>;
                }

                return createMockResponse({
                    id: 'ORDER-TRIM-IDEM',
                    status: 'CREATED',
                    links: [
                        { rel: 'payer-action', href: 'https://paypal.com/checkoutnow?token=ORDER-TRIM-IDEM' },
                    ],
                });
            }) as unknown as typeof fetch;

            await gateway.createPayment({
                amount: money(50, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com/callback',
                idempotencyKey: '  unique-key-abc  ',
            });

            expect(capturedHeaders).not.toBeNull();
            expect(capturedHeaders!['PayPal-Request-Id']).toBe('unique-key-abc');
        });

        it('omitted idempotencyKey still sends minted PayPal-Request-Id (PAYPAL-IDEM-1)', async () => {
            const generatedId = 'generated-paypal-request-id-uuid';
            const idemGateway = new PayPalGateway(
                PAYPAL_TEST_CONFIG,
                hooksManager,
                undefined,
                { randomUUID: () => generatedId },
            );

            let capturedHeaders: Record<string, string> | null = null;
            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('checkout/orders') && init?.headers) {
                    capturedHeaders = init.headers as Record<string, string>;
                }

                return createMockResponse({
                    id: 'ORDER-EMPTY-IDEM',
                    status: 'CREATED',
                    links: [
                        { rel: 'payer-action', href: 'https://paypal.com/checkoutnow?token=ORDER-EMPTY-IDEM' },
                    ],
                });
            }) as unknown as typeof fetch;

            await idemGateway.createPayment({
                amount: money(50, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com/callback',
            });

            expect(capturedHeaders).not.toBeNull();
            expect(capturedHeaders!['PayPal-Request-Id']).toBe(generatedId);
        });

        it('should use payer-action approval links returned by current PayPal APIs', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-PAYER-ACTION',
                status: 'PAYER_ACTION_REQUIRED',
                links: [
                    { rel: 'payer-action', href: 'https://paypal.com/checkoutnow?token=ORDER-PAYER-ACTION' },
                ],
            });

            const result = await gateway.createPayment({
                amount: money(50, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com/callback',
            });

            expect(result.redirectUrl).toBe('https://paypal.com/checkoutnow?token=ORDER-PAYER-ACTION');
            expect(result.status).toBe('pending');
        });

        it('create HTTP 200 missing approval link is indeterminate, not a clean API throw', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                return createMockResponse({
                    id: 'ORDER-NO-LINK',
                    status: 'CREATED',
                });
            }) as unknown as typeof fetch;

            const result = await gateway.createPayment({
                amount: money(50, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com/callback',
            });
            expect(result.outcome).toBe('indeterminate');
            expect(result.reconciliationRequired).toBe(true);
        });

        it('create HTTP 200 missing id is indeterminate, not a clean API throw', async () => {
            globalThis.fetch = createMockFetch({
                status: 'CREATED',
                links: [
                    { rel: 'payer-action', href: 'https://paypal.com/checkoutnow?token=missing-id' },
                ],
            });

            const result = await gateway.createPayment({
                amount: money(50, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com/callback',
            });
            expect(result.outcome).toBe('indeterminate');
            expect(result.reconciliationRequired).toBe(true);
        });

        it('create HTTP 200 empty body is indeterminate, not a clean API throw', async () => {
            globalThis.fetch = createMockFetch({});

            const result = await gateway.createPayment({
                amount: money(50, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com/callback',
            });
            expect(result.outcome).toBe('indeterminate');
            expect(result.reconciliationRequired).toBe(true);
        });

        it('create HTTP 200 empty or non-JSON body is indeterminate, not invented {} (S20-PAYPAL-JSON)', async () => {
            for (const body of ['', '<html>proxy failure</html>']) {
                globalThis.fetch = createMockRawFetch(body);
                const result = await gateway.createPayment({
                    amount: money(50, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com/callback',
                });
                expect(result.outcome).toBe('indeterminate');
                expect(result.reconciliationRequired).toBe(true);
                expect(result.status).not.toBe('failed');
            }
        });

        it('should create AUTHORIZE-intent orders when capture is false', async () => {
            let capturedBody: any = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                capturedBody = JSON.parse(init?.body as string);

                return createMockResponse({
                    id: 'ORDER-AUTH',
                    status: 'CREATED',
                    links: [{ rel: 'payer-action', href: 'https://paypal.com/auth' }],
                });
            }) as unknown as typeof fetch;

            await gateway.createPayment({
                amount: money(75, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com/callback',
                capture: false,
            });

            expect(capturedBody.intent).toBe('AUTHORIZE');
        });

        it('should format zero-decimal PayPal currencies without cents', async () => {
            let capturedBody: any = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                capturedBody = JSON.parse(init?.body as string);

                return createMockResponse({
                    id: 'ORDER-JPY',
                    status: 'CREATED',
                    links: [
                        { rel: 'payer-action', href: 'https://paypal.com/checkoutnow?token=ORDER-JPY' },
                    ],
                });
            }) as unknown as typeof fetch;

            await gateway.createPayment({
                amount: money(1000, "jpy"),
                currency: 'jpy',
                callbackUrl: 'https://example.com/callback',
            });

            expect(capturedBody.purchase_units[0].amount).toEqual({
                currency_code: 'JPY',
                value: '1000',
            });
        });

        it('should reject fractional amounts for zero-decimal PayPal currencies', async () => {
            await expect(
                gateway.createPayment({
                    amount: 1000.5,
                    currency: 'JPY',
                    callbackUrl: 'https://example.com/callback',
                })
            ).rejects.toThrow(InvalidRequestError);
        });

        it('should accept Money amount input for createPayment', async () => {
            let capturedBody: any = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                capturedBody = JSON.parse(init?.body as string);

                return createMockResponse({
                    id: 'ORDER-MONEY',
                    status: 'CREATED',
                    links: [
                        { rel: 'payer-action', href: 'https://paypal.com/checkoutnow?token=ORDER-MONEY' },
                    ],
                });
            }) as unknown as typeof fetch;

            await gateway.createPayment({
                amount: money('10.50', 'USD'),
                currency: 'USD',
                callbackUrl: 'https://example.com/callback',
            });

            expect(capturedBody.purchase_units[0].amount).toEqual({
                currency_code: 'USD',
                value: '10.50',
            });
        });

        it('should reject non-string PayPal custom IDs before calling PayPal', async () => {
            let fetchCount = 0;
            globalThis.fetch = mock(async () => {
                fetchCount++;
                return createMockResponse({});
            }) as unknown as typeof fetch;

            await expect(
                gateway.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com/callback',
                    metadata: { paymentId: 123 },
                })
            ).rejects.toThrow('PayPal metadata.paymentId must be a non-empty string');

            expect(fetchCount).toBe(0);
        });

        it('should reject descriptions longer than PayPal supports before calling PayPal', async () => {
            let fetchCount = 0;
            globalThis.fetch = mock(async () => {
                fetchCount++;
                return createMockResponse({});
            }) as unknown as typeof fetch;

            await expect(
                gateway.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com/callback',
                    description: 'x'.repeat(128),
                })
            ).rejects.toThrow(InvalidRequestError);

            await expect(
                gateway.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com/callback',
                    description: 'x'.repeat(128),
                })
            ).rejects.toThrow('PayPal description must be 127 characters or fewer');

            expect(fetchCount).toBe(0);
        });

        it('should reject orderIds longer than PayPal reference_id supports before calling PayPal', async () => {
            let fetchCount = 0;
            globalThis.fetch = mock(async () => {
                fetchCount++;
                return createMockResponse({});
            }) as unknown as typeof fetch;

            await expect(
                gateway.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com/callback',
                    orderId: 'x'.repeat(257),
                })
            ).rejects.toThrow('PayPal orderId (reference_id) must be 256 characters or fewer');

            expect(fetchCount).toBe(0);
        });

        it('should reject PayPal request IDs longer than PayPal supports', async () => {
            await expect(
                gateway.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com/callback',
                    idempotencyKey: 'x'.repeat(109),
                })
            ).rejects.toThrow('PayPal idempotencyKey must be 108 characters or fewer for this operation');
        });

        it('should throw GatewayApiError on API failure', async () => {
            globalThis.fetch = createMockFetch(
                {
                    name: 'INVALID_REQUEST',
                    message: 'Request is not well-formed',
                    details: [
                        { issue: 'MISSING_REQUIRED_PARAMETER', description: 'Amount is required' },
                    ],
                },
                false,
                400
            );

            await expect(
                gateway.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com/callback',
                })
            ).rejects.toThrow(InvalidRequestError);
        });

        it('should not retry non-retryable PayPal 4xx errors', async () => {
            let apiFetchCount = 0;

            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                apiFetchCount++;
                return createMockResponse(
                    {
                        name: 'INVALID_REQUEST',
                        message: 'Request is not well-formed',
                    },
                    false,
                    400
                );
            }) as unknown as typeof fetch;

            await expect(
                gateway.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com/callback',
                })
            ).rejects.toThrow(InvalidRequestError);

            expect(apiFetchCount).toBe(1);
        });

        it('should retry PayPal resource conflicts when the previous request is still in progress', async () => {
            let apiFetchCount = 0;
            const requestIds: Array<string | undefined> = [];

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                apiFetchCount++;
                requestIds.push((init?.headers as Record<string, string>)['PayPal-Request-Id']);
                if (apiFetchCount === 1) {
                    return createMockResponse(
                        {
                            name: 'RESOURCE_CONFLICT',
                            message: 'Previous request is still processing',
                            details: [
                                { issue: 'PREVIOUS_REQUEST_IN_PROGRESS' },
                            ],
                        },
                        false,
                        409
                    );
                }

                return createMockResponse({
                    id: 'ORDER-CONFLICT-RETRIED',
                    status: 'CREATED',
                    links: [
                        { rel: 'payer-action', href: 'https://paypal.com/checkoutnow?token=ORDER-CONFLICT-RETRIED' },
                    ],
                });
            }) as unknown as typeof fetch;

            const result = await gateway.createPayment({
                amount: money(10, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com/callback',
                idempotencyKey: 'conflict-retry-key',
            });

            expect(result.gatewayId).toBe('ORDER-CONFLICT-RETRIED');
            expect(apiFetchCount).toBe(2);
            expect(requestIds).toEqual(['conflict-retry-key', 'conflict-retry-key']);
        });

        it('should include detailed error message from details array', async () => {
            globalThis.fetch = createMockFetch(
                {
                    name: 'UNPROCESSABLE_ENTITY',
                    message: 'The requested action could not be performed',
                    details: [
                        { issue: 'CURRENCY_NOT_SUPPORTED', description: 'Currency XYZ is not supported' },
                        { issue: 'AMOUNT_MISMATCH', description: 'Amount does not match' },
                    ],
                },
                false,
                422
            );

            try {
                // Use a known ISO currency so the request reaches PayPal; the
                // mock returns CURRENCY_NOT_SUPPORTED for an unknown provider code.
                await gateway.createPayment({
                    amount: money(100, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com/callback',
                });
                expect(true).toBe(false); // Should not reach
            } catch (error: any) {
                expect(error.name).toBe('InvalidRequestError');
                const apiError = error as InvalidRequestError;
                expect(apiError.message).toContain('Currency XYZ is not supported');
                expect(apiError.message).toContain('Amount does not match');
            }
        });

        it('should return InvalidRequestError when PayPal sends a non-JSON 4xx body', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                return {
                    ok: false,
                    status: 400,
                    headers: new Headers(),
                    redirected: false,
                    statusText: 'Bad Gateway',
                    type: 'basic',
                    url: '',
                    clone: () => ({} as Response),
                    body: null,
                    bodyUsed: false,
                    arrayBuffer: async () => new ArrayBuffer(0),
                    blob: async () => new Blob(),
                    formData: async () => new FormData(),
                    json: async () => {
                        throw new SyntaxError('Unexpected token');
                    },
                    text: async () => '<html>proxy failure</html>',
                } as Response;
            }) as unknown as typeof fetch;

            await expect(
                gateway.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com/callback',
                })
            ).rejects.toThrow(InvalidRequestError);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Capture Payment Tests
    // ═══════════════════════════════════════════════════════════════════════════

    describe('capturePayment', () => {
        it('S19-EPHEMERAL-KEY: capturePayment requires caller idempotencyKey before POST', async () => {
            let fetchCalls = 0;
            globalThis.fetch = mock(async () => {
                fetchCalls += 1;
                return createMockResponse({ id: 'ORDER-NOKEY', status: 'COMPLETED' });
            }) as unknown as typeof fetch;

            await expect(
                gateway.capturePayment({ gatewayPaymentId: 'ORDER-NOKEY' }),
            ).rejects.toThrow(/requires idempotencyKey/i);
            expect(fetchCalls).toBe(0);
        });

        it('should capture order and return capture ID', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-789',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        payments: {
                            captures: [
                                {
                                    id: 'CAPTURE-XYZ',
                                    status: 'COMPLETED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '150.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.capturePayment({
                gatewayPaymentId: 'ORDER-789',
                idempotencyKey: 'test-idem',
            });

            expect(result.gatewayId).toBe('CAPTURE-XYZ');
            expect(result.orderId).toBe('ORDER-789');
            expect(result.captureId).toBe('CAPTURE-XYZ');
            // NEW-PAYPAL-7: omitted final_capture is not paid (same as GET / webhook).
            expect(result.status).toBe('partially_captured');
            expect(result.status).not.toBe('paid');
            expect(moneyToMajorNumber(result.amount!)).toBe(150);
            // PAYPAL-1: currency published with major-unit amount
            expect(result.currency).toBe('USD');
            expect((result.rawResponse as any).captureId).toBe('CAPTURE-XYZ');
            expect((result.rawResponse as any).orderId).toBe('ORDER-789');
            expect(result.outcome).toBe('requires_action');
            expect(result.outcome).not.toBe('succeeded');
            expect(isPaidOutcome(result)).toBe(false);
            expect(result.references?.providerObjectId).toBe('CAPTURE-XYZ');
            expect(result.references?.relatedIds?.captureId).toBe('CAPTURE-XYZ');
            expect(result.references?.relatedIds?.orderId).toBe('ORDER-789');
        });

        it('order capture HTTP 200 COMPLETED without final_capture is not paid (NEW-PAYPAL-7)', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-OMITTED-FINAL',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        payments: {
                            captures: [
                                {
                                    id: 'CAPTURE-OMITTED-FINAL',
                                    status: 'COMPLETED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '40.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.capturePayment({
                gatewayPaymentId: 'ORDER-OMITTED-FINAL',
                idempotencyKey: 'test-idem',
            });

            expect(result.captureId).toBe('CAPTURE-OMITTED-FINAL');
            expect(result.gatewayId).toBe('CAPTURE-OMITTED-FINAL');
            expect(result.status).toBe('partially_captured');
            expect(result.status).not.toBe('paid');
            expect(result.outcome).toBe('requires_action');
            expect(result.outcome).not.toBe('succeeded');
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('order capture HTTP 200 COMPLETED with final_capture true is paid', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-FINAL',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        payments: {
                            captures: [
                                {
                                    id: 'CAPTURE-FINAL',
                                    status: 'COMPLETED',
                                    final_capture: true,
                                    amount: {
                                        currency_code: 'USD',
                                        value: '40.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.capturePayment({
                gatewayPaymentId: 'ORDER-FINAL',
                idempotencyKey: 'test-idem',
            });

            expect(result.captureId).toBe('CAPTURE-FINAL');
            expect(result.status).toBe('paid');
            expect(result.outcome).toBe('succeeded');
            expect(isPaidOutcome(result)).toBe(true);
        });

        it('should return pending with requires_action outcome for pending captures and warn', async () => {
            const warnings: string[] = [];
            const warnGateway = new PayPalGateway(
                PAYPAL_TEST_CONFIG,
                hooksManager,
                captureLogger(warnings),
            );

            globalThis.fetch = createMockFetch({
                id: 'ORDER-PENDING-CAPTURE',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        payments: {
                            captures: [
                                {
                                    id: 'CAPTURE-PENDING',
                                    status: 'PENDING',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '10.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await warnGateway.capturePayment({
                gatewayPaymentId: 'ORDER-PENDING-CAPTURE',
                idempotencyKey: 'test-idem',
            });

            expect(result.status).toBe('pending');
            expect(result.captureId).toBe('CAPTURE-PENDING');
            expect(result.outcome).toBe('requires_action');
            expect(result.outcome).not.toBe('succeeded');
            expect(warnings.some((message) =>
                message.includes('pending status') && message.includes('do not fulfill'),
            )).toBe(true);
        });

        it('should map capture DENIED to failed with declined outcome', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-FAILED-CAPTURE',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        payments: {
                            captures: [
                                {
                                    id: 'CAPTURE-DENIED',
                                    status: 'DENIED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '10.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.capturePayment({
                gatewayPaymentId: 'ORDER-FAILED-CAPTURE',
                idempotencyKey: 'test-idem',
            });

            expect(result.status).toBe('failed');
            expect(result.captureId).toBe('CAPTURE-DENIED');
            expect(result.outcome).toBe('declined');
            expect(result.decline).toBeDefined();
        });

        it('should return indeterminate when order capture omits capture details', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-NO-CAPTURE',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        payments: {
                            captures: [],
                        },
                    },
                ],
            });

            const result = await gateway.capturePayment({
                gatewayPaymentId: 'ORDER-NO-CAPTURE',
                idempotencyKey: 'test-idem',
            });
            expect(result.outcome).toBe('indeterminate');
            expect(result.reconciliationRequired).toBe(true);
        });

        it('should include PayPal-Request-Id header when capturing orders', async () => {
            let capturedHeaders: Record<string, string> | null = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                capturedHeaders = init?.headers as Record<string, string>;
                return createMockResponse({
                    id: 'ORDER-789',
                    status: 'COMPLETED',
                    purchase_units: [
                        {
                            payments: {
                                captures: [
                                    {
                                        id: 'CAPTURE-XYZ',
                                        status: 'COMPLETED',
                                        amount: {
                                            currency_code: 'USD',
                                            value: '150.00',
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                });
            }) as unknown as typeof fetch;

            await gateway.capturePayment({
                gatewayPaymentId: 'ORDER-789',
                idempotencyKey: 'capture-idem-1',
            });

            expect(capturedHeaders!['PayPal-Request-Id']).toBe('capture-idem-1');
            expect(capturedHeaders!.Prefer).toBe('return=representation');
        });

        it('should capture PayPal authorizations when requested', async () => {
            let capturedUrl: string | null = null;
            let capturedBody: unknown = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                capturedUrl = url;
                capturedBody = JSON.parse(init?.body as string);

                return createMockResponse({
                    id: 'CAPTURE-AUTH',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '20.00',
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.capturePayment({
                gatewayPaymentId: 'AUTH-123',
                amount: money(20, "USD"),
                currency: 'USD',
                paypalCaptureType: 'authorization',
                idempotencyKey: 'test-idem',
            });

            expect(capturedUrl as unknown as string).toContain('/v2/payments/authorizations/AUTH-123/capture');
            // amount set => partial; default final_capture false unless paypalFinalCapture === true
            expect(capturedBody).toEqual({
                amount: {
                    value: '20.00',
                    currency_code: 'USD',
                },
                final_capture: false,
            });
            expect(result.gatewayId).toBe('CAPTURE-AUTH');
            expect(result.captureId).toBe('CAPTURE-AUTH');
            expect(result.authorizationId).toBe('AUTH-123');
            // Non-final partial capture is not full settlement (PAYPAL-1)
            expect(result.status).toBe('partially_captured');
            expect(moneyToMajorNumber(result.amount!)).toBe(20);
            expect(result.outcome).toBe('requires_action');
            expect(result.outcome).not.toBe('succeeded');
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('should default partial authorization captures to final_capture false', async () => {
            let capturedBody: unknown = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                capturedBody = JSON.parse(init?.body as string);

                return createMockResponse({
                    id: 'CAPTURE-PARTIAL-DEFAULT',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '10.00',
                    },
                });
            }) as unknown as typeof fetch;

            await gateway.capturePayment({
                gatewayPaymentId: 'AUTH-PARTIAL-DEFAULT',
                amount: money(10, "USD"),
                currency: 'USD',
                paypalCaptureType: 'authorization',
                // paypalFinalCapture omitted
                idempotencyKey: 'test-idem',
            });

            expect(capturedBody).toEqual({
                amount: {
                    value: '10.00',
                    currency_code: 'USD',
                },
                final_capture: false,
            });
        });

        it('should allow final_capture true on partial amount when paypalFinalCapture is true', async () => {
            let capturedBody: unknown = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                capturedBody = JSON.parse(init?.body as string);

                return createMockResponse({
                    id: 'CAPTURE-PARTIAL-FINAL',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '10.00',
                    },
                    final_capture: true,
                });
            }) as unknown as typeof fetch;

            const result = await gateway.capturePayment({
                gatewayPaymentId: 'AUTH-PARTIAL-FINAL',
                amount: money(10, "USD"),
                currency: 'USD',
                paypalCaptureType: 'authorization',
                paypalFinalCapture: true,
                idempotencyKey: 'test-idem',
            });

            expect(capturedBody).toEqual({
                amount: {
                    value: '10.00',
                    currency_code: 'USD',
                },
                final_capture: true,
            });
            expect(result.status).toBe('paid');
            expect(isPaidOutcome(result)).toBe(true);
        });

        it('should reject amount on order captures because PayPal only supports partial authorization captures', async () => {
            let fetchCount = 0;
            globalThis.fetch = mock(async () => {
                fetchCount++;
                return createMockResponse({});
            }) as unknown as typeof fetch;

            await expect(
                gateway.capturePayment({
                    gatewayPaymentId: 'ORDER-789',
                    amount: money(10, "USD"),
                    currency: 'USD',
                    idempotencyKey: 'test-idem',
                })
            ).rejects.toThrow(InvalidRequestError);

            expect(fetchCount).toBe(0);
        });

        it('should mark full authorization captures as final by default', async () => {
            let capturedBody: unknown = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                capturedBody = JSON.parse(init?.body as string);

                return createMockResponse({
                    id: 'CAPTURE-AUTH-FULL',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '75.00',
                    },
                });
            }) as unknown as typeof fetch;

            await gateway.capturePayment({
                gatewayPaymentId: 'AUTH-456',
                paypalCaptureType: 'authorization',
                idempotencyKey: 'test-idem',
            });

            expect(capturedBody).toEqual({
                final_capture: true,
            });
        });

        it('should allow non-final authorization captures when explicitly requested', async () => {
            let capturedBody: unknown = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                capturedBody = JSON.parse(init?.body as string);

                return createMockResponse({
                    id: 'CAPTURE-AUTH-PARTIAL',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '25.00',
                    },
                    final_capture: false,
                });
            }) as unknown as typeof fetch;

            const result = await gateway.capturePayment({
                gatewayPaymentId: 'AUTH-789',
                amount: money(25, "USD"),
                currency: 'USD',
                paypalCaptureType: 'authorization',
                paypalFinalCapture: false,
                idempotencyKey: 'test-idem',
            });

            expect(capturedBody).toEqual({
                amount: {
                    value: '25.00',
                    currency_code: 'USD',
                },
                final_capture: false,
            });
            expect(result.status).toBe('partially_captured');
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('S19-EPHEMERAL-KEY: authorizePayment requires caller idempotencyKey before POST', async () => {
            let fetchCalls = 0;
            globalThis.fetch = mock(async () => {
                fetchCalls += 1;
                return createMockResponse({ id: 'ORDER-AUTH-NOKEY', status: 'COMPLETED' });
            }) as unknown as typeof fetch;

            await expect(
                gateway.authorizePayment({ gatewayPaymentId: 'ORDER-AUTH-NOKEY' }),
            ).rejects.toThrow(/requires idempotencyKey/i);
            expect(fetchCalls).toBe(0);
        });

        it('should authorize an approved AUTHORIZE-intent order and return authorization ID', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-AUTH',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        payments: {
                            authorizations: [
                                {
                                    id: 'AUTH-XYZ',
                                    status: 'CREATED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '150.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.authorizePayment({
                gatewayPaymentId: 'ORDER-AUTH',
                idempotencyKey: 'test-idem',
            });

            expect(result.outcome).toBe('succeeded');
            expect(result.gatewayId).toBe('AUTH-XYZ');
            expect(result.orderId).toBe('ORDER-AUTH');
            expect(result.authorizationId).toBe('AUTH-XYZ');
            expect(result.status).toBe('authorized');
            expect((result.rawResponse as any).authorizationId).toBe('AUTH-XYZ');
        });

        it('should map authorize DENIED to failed with declined outcome', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-AUTH-DENIED',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        payments: {
                            authorizations: [
                                {
                                    id: 'AUTH-DENIED',
                                    status: 'DENIED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '10.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.authorizePayment({
                gatewayPaymentId: 'ORDER-AUTH-DENIED',
                idempotencyKey: 'test-idem',
            });

            expect(result.status).toBe('failed');
            expect(result.outcome).toBe('declined');
            expect(result.authorizationId).toBe('AUTH-DENIED');
        });

        it('should return indeterminate when authorize omits authorization details', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-AUTH-MISSING',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        payments: {
                            authorizations: [],
                        },
                    },
                ],
            });

            const result = await gateway.authorizePayment({
                gatewayPaymentId: 'ORDER-AUTH-MISSING',
                idempotencyKey: 'test-idem',
            });
            expect(result.outcome).toBe('indeterminate');
            expect(result.reconciliationRequired).toBe(true);
        });

        it('should reject capture-only fields on authorizePayment before calling PayPal', async () => {
            let fetchCount = 0;
            globalThis.fetch = mock(async () => {
                fetchCount++;
                return createMockResponse({});
            }) as unknown as typeof fetch;

            await expect(
                gateway.authorizePayment({
                    gatewayPaymentId: 'ORDER-AUTH-STRICT',
                    amount: 10,
                    currency: 'USD',
                    idempotencyKey: 'test-idem',
                })
            ).rejects.toThrow(InvalidRequestError);

            expect(fetchCount).toBe(0);
        });

        it('should map partially captured authorizations distinctly', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-AUTH-PARTIAL',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        payments: {
                            authorizations: [
                                {
                                    id: 'AUTH-PARTIAL',
                                    status: 'PARTIALLY_CAPTURED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '150.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.getPayment({ gatewayPaymentId: 'ORDER-AUTH-PARTIAL' });

            expect(result.status).toBe('partially_captured');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Refund Payment Tests
    // ═══════════════════════════════════════════════════════════════════════════

    describe('refundPayment', () => {
        it('S19-EPHEMERAL-KEY: refundPayment requires caller idempotencyKey before POST', async () => {
            let fetchCalls = 0;
            globalThis.fetch = mock(async () => {
                fetchCalls += 1;
                return createMockResponse({ id: 'REFUND-NOKEY' });
            }) as unknown as typeof fetch;

            await expect(
                gateway.refundPayment({ gatewayPaymentId: 'CAPTURE-NOKEY' }),
            ).rejects.toThrow(/requires idempotencyKey/i);
            expect(fetchCalls).toBe(0);
        });

        it('should throw error when currency is missing for partial refund', async () => {
            globalThis.fetch = createMockFetch({
                access_token: 'test_token',
                expires_in: 3600,
            });

            await expect(
                gateway.refundPayment({
                    gatewayPaymentId: 'CAPTURE-123',
                    amount: money(50, "USD"), // Partial refund without currency
                    idempotencyKey: 'test-idem',
                })
            ).rejects.toThrow('Currency is required for partial PayPal refunds');
        });

        it('should reject refund reasons longer than PayPal note_to_payer supports', async () => {
            let fetchCount = 0;
            globalThis.fetch = mock(async () => {
                fetchCount++;
                return createMockResponse({});
            }) as unknown as typeof fetch;

            await expect(
                gateway.refundPayment({
                    gatewayPaymentId: 'CAPTURE-123',
                    reason: 'x'.repeat(256),
                    idempotencyKey: 'test-idem',
                })
            ).rejects.toThrow('PayPal refund reason (note_to_payer) must be 255 characters or fewer');

            expect(fetchCount).toBe(0);
        });

        it('should refund with succeeded outcome and cumulative totalRefunded', async () => {
            let capturedHeaders: Record<string, string> | null = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                // Capture GET after refund (cumulative totalRefunded recovery)
                if (url.includes('/v2/payments/captures/CAPTURE-123') && !url.includes('/refund')) {
                    return createMockResponse({
                        id: 'CAPTURE-123',
                        status: 'PARTIALLY_REFUNDED',
                        amount: {
                            currency_code: 'USD',
                            value: '100.00',
                        },
                        seller_receivable_breakdown: {
                            total_refunded_amount: {
                                currency_code: 'USD',
                                value: '25.50',
                            },
                        },
                    });
                }

                capturedHeaders = init?.headers as Record<string, string>;
                return createMockResponse({
                    id: 'REFUND-ABC',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '25.50',
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.refundPayment({
                gatewayPaymentId: 'CAPTURE-123',
                amount: money(25.5, "USD"),
                currency: 'USD',
                reason: 'Customer request',
                idempotencyKey: 'refund-idem-1',
            });

            expect(result.outcome).toBe('succeeded');
            expect(result.gatewayRefundId).toBe('REFUND-ABC');
            expect(result.status).toBe('completed');
            // PAYPAL-2: capture-wide cumulative (from capture GET), not this-op alone
            expect(moneyToMajorNumber(result.totalRefunded!)).toBe(25.5);
            expect(capturedHeaders!['PayPal-Request-Id']).toBe('refund-idem-1');
            expect(capturedHeaders!.Prefer).toBe('return=representation');
        });

        it('omits totalRefunded when only this-op amount is known (PAYPAL-2 fail-closed)', async () => {
            // No seller_payable_breakdown and capture GET has no cumulative → omit.
            globalThis.fetch = createMockFetch({
                id: 'REFUND-NO-CUMULATIVE',
                status: 'COMPLETED',
                amount: {
                    currency_code: 'USD',
                    value: '12.34',
                },
            });

            const result = await gateway.refundPayment({
                gatewayPaymentId: 'CAPTURE-123',
                amount: money(12.34, "USD"),
                currency: 'USD',
                idempotencyKey: 'test-idem',
            });

            // Must not publish this-op as totalRefunded (would under-count priors).
            expect(result.totalRefunded).toBeUndefined();
            expect(result.status).toBe('completed');
        });

        it('maps cumulative totalRefunded from seller_payable_breakdown (PAYPAL-2)', async () => {
            globalThis.fetch = createMockFetch({
                id: 'REFUND-CUMULATIVE',
                status: 'COMPLETED',
                amount: {
                    currency_code: 'USD',
                    value: '10.00',
                },
                seller_payable_breakdown: {
                    total_refunded_amount: {
                        currency_code: 'USD',
                        value: '30.00',
                    },
                },
            });

            const result = await gateway.refundPayment({
                gatewayPaymentId: 'CAPTURE-123',
                amount: money(10, "USD"),
                currency: 'USD',
                idempotencyKey: 'test-idem',
            });

            // Prior 20 + this op 10 = 30 (not this-op 10).
            expect(moneyToMajorNumber(result.totalRefunded!)).toBe(30);
            expect(result.status).toBe('completed');
        });

        it('maps cumulative totalRefunded from capture GET when refund body omits breakdown (PAYPAL-2)', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('/v2/payments/captures/CAP-PRIOR') && !url.includes('/refund')) {
                    return createMockResponse({
                        id: 'CAP-PRIOR',
                        status: 'PARTIALLY_REFUNDED',
                        amount: {
                            currency_code: 'USD',
                            value: '100.00',
                        },
                        seller_receivable_breakdown: {
                            total_refunded_amount: {
                                currency_code: 'USD',
                                value: '45.00',
                            },
                        },
                    });
                }

                return createMockResponse({
                    id: 'REFUND-SECOND',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '15.00',
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.refundPayment({
                gatewayPaymentId: 'CAP-PRIOR',
                amount: money(15, "USD"),
                currency: 'USD',
                idempotencyKey: 'test-idem',
            });

            expect(moneyToMajorNumber(result.totalRefunded!)).toBe(45);
        });

        it('refund HTTP 200 missing id is indeterminate, not a clean API throw', async () => {
            globalThis.fetch = createMockFetch({
                status: 'COMPLETED',
            });

            const result = await gateway.refundPayment({
                gatewayPaymentId: 'CAPTURE-123',
                idempotencyKey: 'test-idem',
            });
            expect(result.outcome).toBe('indeterminate');
            expect(result.reconciliationRequired).toBe(true);
        });

        it('refund HTTP 200 empty body is indeterminate, not a clean API throw', async () => {
            globalThis.fetch = createMockFetch({});

            const result = await gateway.refundPayment({
                gatewayPaymentId: 'CAPTURE-123',
                idempotencyKey: 'test-idem',
            });
            expect(result.outcome).toBe('indeterminate');
            expect(result.reconciliationRequired).toBe(true);
        });

        it('refund HTTP 200 empty or non-JSON body is indeterminate, not invented {} (S20-PAYPAL-JSON)', async () => {
            for (const body of ['', '<html>proxy failure</html>']) {
                globalThis.fetch = createMockRawFetch(body);
                const result = await gateway.refundPayment({
                    gatewayPaymentId: 'CAPTURE-123',
                    idempotencyKey: 'test-idem-json',
                });
                expect(result.outcome).toBe('indeterminate');
                expect(result.reconciliationRequired).toBe(true);
                expect(result.status).not.toBe('failed');
            }
        });

        it('should map failed refund statuses to failed outcome', async () => {
            globalThis.fetch = createMockFetch({
                id: 'REFUND-FAILED',
                status: 'FAILED',
            });

            const result = await gateway.refundPayment({
                gatewayPaymentId: 'CAPTURE-123',
                idempotencyKey: 'test-idem',
            });

            expect(result.status).toBe('failed');
            expect(result.outcome).toBe('failed');
        });

        it('S20-PAYPAL-REFUND-UNKNOWN: HTTP 200 unknown refund status is pending, never failed', async () => {
            const warnings: string[] = [];
            const warnGateway = new PayPalGateway(
                PAYPAL_TEST_CONFIG,
                hooksManager,
                captureLogger(warnings),
            );

            globalThis.fetch = createMockFetch({
                id: 'REFUND-UNKNOWN',
                status: 'WEIRD_NEW_STATUS',
            });

            const result = await warnGateway.refundPayment({
                gatewayPaymentId: 'CAPTURE-123',
                idempotencyKey: 'test-idem',
            });

            expect(result.status).toBe('pending');
            expect(result.outcome).toBe('pending');
            expect(result.status).not.toBe('failed');
            expect(result.outcome).not.toBe('failed');
            expect(result.totalRefunded).toBeUndefined();
            expect(warnings.some((message) =>
                message.includes('Unmapped refund status') && message.includes('pending'),
            )).toBe(true);
        });

        it('should clarify that refunds need a capture ID when the resource is not found', async () => {
            globalThis.fetch = createMockFetch(
                {
                    name: 'RESOURCE_NOT_FOUND',
                    message: 'The specified resource does not exist.',
                },
                false,
                404,
            );

            await expect(
                gateway.refundPayment({
                    gatewayPaymentId: 'ORDER-NOT-A-CAPTURE',
                    idempotencyKey: 'test-idem',
                }),
            ).rejects.toThrow(ResourceNotFoundError);

            await expect(
                gateway.refundPayment({
                    gatewayPaymentId: 'ORDER-NOT-A-CAPTURE',
                    idempotencyKey: 'test-idem',
                }),
            ).rejects.toThrow(
                /PayPal refund requires capture ID from capturePayment, not order\/authorization ID/,
            );
        });

        it('should refund full amount without currency', async () => {
            let capturedBody: unknown = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                // Capture refund POST only (follow-up capture GET has no body).
                if (url.includes('/refund')) {
                    capturedBody = init?.body;
                    return createMockResponse({
                        id: 'REFUND-FULL',
                        status: 'COMPLETED',
                    });
                }

                // Capture GET for cumulative totalRefunded recovery.
                return createMockResponse({
                    id: 'CAPTURE-456',
                    status: 'REFUNDED',
                    amount: {
                        currency_code: 'USD',
                        value: '100.00',
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.refundPayment({
                gatewayPaymentId: 'CAPTURE-456',
                // No amount = full refund
                idempotencyKey: 'test-idem',
            });

            // Full refund should send an empty JSON payload per PayPal docs
            expect(capturedBody).toBe('{}');
            // Fully REFUNDED capture face is the capture-wide total.
            expect(moneyToMajorNumber(result.totalRefunded!)).toBe(100);
        });

        it('should allow longer Payments v2 idempotency keys for refunds', async () => {
            let capturedHeaders: Record<string, string> | null = null;
            const longPaymentsRequestId = 'x'.repeat(109);

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('/refund')) {
                    capturedHeaders = init?.headers as Record<string, string>;
                    return createMockResponse({
                        id: 'REFUND-LONG-IDEMPOTENCY',
                        status: 'COMPLETED',
                    });
                }

                return createMockResponse({
                    id: 'CAPTURE-456',
                    status: 'REFUNDED',
                    amount: {
                        currency_code: 'USD',
                        value: '50.00',
                    },
                });
            }) as unknown as typeof fetch;

            await gateway.refundPayment({
                gatewayPaymentId: 'CAPTURE-456',
                idempotencyKey: longPaymentsRequestId,
            });

            expect(capturedHeaders!['PayPal-Request-Id']).toBe(longPaymentsRequestId);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Void Payment Tests
    // ═══════════════════════════════════════════════════════════════════════════

    describe('voidPayment', () => {
        it('S19-EPHEMERAL-KEY: voidPayment requires caller idempotencyKey before POST', async () => {
            let fetchCalls = 0;
            globalThis.fetch = mock(async () => {
                fetchCalls += 1;
                return createMockResponse(null, true, 204);
            }) as unknown as typeof fetch;

            await expect(
                gateway.voidPayment({ gatewayPaymentId: 'AUTH-NOKEY' }),
            ).rejects.toThrow(/requires idempotencyKey/i);
            expect(fetchCalls).toBe(0);
        });

        it('should void an authorized payment with succeeded outcome (204 response)', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                // PayPal returns 204 No Content on successful void
                return {
                    ok: true,
                    status: 204,
                    json: async () => null,
                    headers: new Headers(),
                    redirected: false,
                    statusText: 'No Content',
                    type: 'basic',
                    url: '',
                    clone: () => ({} as Response),
                    body: null,
                    bodyUsed: false,
                    arrayBuffer: async () => new ArrayBuffer(0),
                    blob: async () => new Blob(),
                    formData: async () => new FormData(),
                    text: async () => '',
                } as Response;
            }) as unknown as typeof fetch;

            const result = await gateway.voidPayment({
                gatewayPaymentId: 'AUTH-123',
                idempotencyKey: 'test-idem',
            });

            expect(result.outcome).toBe('succeeded');
            expect(result.gatewayId).toBe('AUTH-123');
            expect(result.status).toBe('cancelled');
        });

        it('should call correct void endpoint', async () => {
            let capturedUrl: string | null = null;
            let capturedHeaders: Record<string, string> | null = null;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                capturedUrl = url;
                capturedHeaders = init?.headers as Record<string, string>;

                return {
                    ok: true,
                    status: 204,
                    json: async () => null,
                    headers: new Headers(),
                    redirected: false,
                    statusText: 'No Content',
                    type: 'basic',
                    url: '',
                    clone: () => ({} as Response),
                    body: null,
                    bodyUsed: false,
                    arrayBuffer: async () => new ArrayBuffer(0),
                    blob: async () => new Blob(),
                    formData: async () => new FormData(),
                    text: async () => '',
                } as Response;
            }) as unknown as typeof fetch;

            await gateway.voidPayment({
                gatewayPaymentId: 'AUTH-456',
                idempotencyKey: 'void-idem-1',
            });

            expect(capturedUrl as unknown as string).toContain('/v2/payments/authorizations/AUTH-456/void');
            expect(capturedHeaders!['PayPal-Request-Id']).toBe('void-idem-1');
        });

        it('should throw InvalidRequestError when void fails business validation', async () => {
            globalThis.fetch = createMockFetch(
                {
                    name: 'UNPROCESSABLE_ENTITY',
                    message: 'Authorization has already been captured',
                    details: [
                        { issue: 'AUTHORIZATION_ALREADY_CAPTURED', description: 'This authorization has been captured' },
                    ],
                },
                false,
                422
            );

            await expect(
                gateway.voidPayment({
                    gatewayPaymentId: 'AUTH-CAPTURED',
                    idempotencyKey: 'test-idem',
                })
            ).rejects.toThrow(InvalidRequestError);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Token Caching Tests
    // ═══════════════════════════════════════════════════════════════════════════

    describe('Token Caching', () => {
        it('should cache access token and reuse it', async () => {
            let tokenFetchCount = 0;

            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    tokenFetchCount++;
                    return createMockResponse({
                        access_token: 'cached_token_xyz',
                        expires_in: 3600,
                    });
                }

                return createMockResponse({
                    id: 'ORDER-TEST',
                    status: 'CREATED',
                    links: [
                        { rel: 'payer-action', href: 'https://paypal.com/checkoutnow?token=ORDER-TEST' },
                    ],
                });
            }) as unknown as typeof fetch;

            // Create a fresh gateway for this test
            const freshGateway = new PayPalGateway(PAYPAL_TEST_CONFIG, hooksManager);

            // Make multiple requests
            await freshGateway.createPayment({
                amount: money(10, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com',
            });

            await freshGateway.createPayment({
                amount: money(20, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com',
            });

            await freshGateway.createPayment({
                amount: money(30, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com',
            });

            // Token should only be fetched once
            expect(tokenFetchCount).toBe(1);
        });

        it('should refresh the cached token once when PayPal returns 401', async () => {
            let tokenFetchCount = 0;
            let orderFetchCount = 0;

            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    tokenFetchCount++;
                    return createMockResponse({
                        access_token: `token_${tokenFetchCount}`,
                        expires_in: 3600,
                    });
                }

                orderFetchCount++;
                if (orderFetchCount === 1) {
                    return createMockResponse(
                        {
                            name: 'AUTHENTICATION_FAILURE',
                            message: 'Token rejected',
                        },
                        false,
                        401
                    );
                }

                return createMockResponse({
                    id: 'ORDER-REFRESHED',
                    status: 'CREATED',
                    links: [
                        { rel: 'payer-action', href: 'https://paypal.com/checkoutnow?token=ORDER-REFRESHED' },
                    ],
                });
            }) as unknown as typeof fetch;

            const freshGateway = new PayPalGateway(PAYPAL_TEST_CONFIG, hooksManager);

            const result = await freshGateway.createPayment({
                amount: money(10, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com',
            });

            expect(result.gatewayId).toBe('ORDER-REFRESHED');
            expect(tokenFetchCount).toBe(2);
            expect(orderFetchCount).toBe(2);
        });

        it('should reject malformed access token responses without expires_in', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'token_without_expiry',
                    });
                }

                return createMockResponse({
                    id: 'ORDER-SHOULD-NOT-RUN',
                    status: 'CREATED',
                });
            }) as unknown as typeof fetch;

            await expect(
                gateway.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com',
                })
            ).rejects.toThrow(GatewayApiError);
        });

        it('should compare tokenExpiry against clock.nowMs() not wall Date (P610-CLK-1)', async () => {
            let nowMs = 1_000_000;
            let tokenFetchCount = 0;
            const clock = {
                now: () => new Date(nowMs),
                nowMs: () => nowMs,
            };

            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    tokenFetchCount++;
                    return createMockResponse({
                        access_token: `clock_token_${tokenFetchCount}`,
                        expires_in: 3600,
                    });
                }

                return createMockResponse({
                    id: `ORDER-CLOCK-${tokenFetchCount}`,
                    status: 'CREATED',
                    links: [
                        { rel: 'payer-action', href: 'https://paypal.com/checkoutnow?token=ORDER-CLOCK' },
                    ],
                });
            }) as unknown as typeof fetch;

            const clockGateway = new PayPalGateway(
                PAYPAL_TEST_CONFIG,
                hooksManager,
                undefined,
                { clock },
            );

            await clockGateway.createPayment({
                amount: money(10, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com',
            });
            await clockGateway.createPayment({
                amount: money(20, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com',
            });

            // Fake epoch is 1970; comparing expiry to `new Date()` would refetch every time.
            expect(tokenFetchCount).toBe(1);

            // expires_in 3600 → refresh 300s early → expiry at nowMs + 3_300_000
            nowMs = 1_000_000 + 3_300_001;
            await clockGateway.createPayment({
                amount: money(30, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com',
            });
            expect(tokenFetchCount).toBe(2);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Lifecycle Hooks Tests
    // ═══════════════════════════════════════════════════════════════════════════

    describe('Lifecycle Hooks', () => {
        it('should execute beforeCreatePayment hook', async () => {
            let hookCalled = false;
            let hookGateway: string | undefined;

            const hooksWithBefore = new HooksManager({
                beforeCreatePayment: async (ctx: HookContext<CreatePaymentParams>) => {
                    hookCalled = true;
                    hookGateway = ctx.gateway;
                    return { proceed: true };
                },
            });

            const gatewayWithHooks = new PayPalGateway(PAYPAL_TEST_CONFIG, hooksWithBefore);

            globalThis.fetch = createMockFetch({
                id: 'ORDER-HOOK',
                status: 'CREATED',
            });

            await gatewayWithHooks.createPayment({
                amount: money(10, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com',
            });

            expect(hookCalled).toBe(true);
            expect(hookGateway).toBe('paypal');
        });

        it('should abort payment when hook returns proceed: false', async () => {
            const hooksWithAbort = new HooksManager({
                beforeCreatePayment: async () => {
                    return { proceed: false, abortReason: 'Blocked by fraud check' };
                },
            });

            const gatewayWithAbort = new PayPalGateway(PAYPAL_TEST_CONFIG, hooksWithAbort);

            await expect(
                gatewayWithAbort.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com',
                })
            ).rejects.toThrow('Blocked by fraud check');
        });

        it('should execute PayPal authorizePayment hooks separately from capture hooks', async () => {
            let authorizeHookCalled = false;
            let captureHookCalled = false;

            const hooksWithAuthorize = new HooksManager({
                beforeAuthorize: async () => {
                    authorizeHookCalled = true;
                    return { proceed: true };
                },
                beforeCapture: async () => {
                    captureHookCalled = true;
                    return { proceed: true };
                },
            });

            const gatewayWithHooks = new PayPalGateway(PAYPAL_TEST_CONFIG, hooksWithAuthorize);

            globalThis.fetch = createMockFetch({
                id: 'ORDER-AUTH-HOOK',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        payments: {
                            authorizations: [
                                {
                                    id: 'AUTH-HOOK',
                                    status: 'CREATED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '10.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            await gatewayWithHooks.authorizePayment({
                gatewayPaymentId: 'ORDER-AUTH-HOOK',
                idempotencyKey: 'test-idem',
            });

            expect(authorizeHookCalled).toBe(true);
            expect(captureHookCalled).toBe(false);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // GetPayment Tests
    // ═══════════════════════════════════════════════════════════════════════════

    describe('getPayment', () => {
        it('should retrieve order details', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-GET-123',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        amount: {
                            currency_code: 'USD',
                            value: '200.00',
                        },
                        payments: {
                            captures: [
                                {
                                    id: 'CAP-001',
                                    status: 'COMPLETED',
                                    final_capture: true,
                                    amount: {
                                        currency_code: 'USD',
                                        value: '200.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.getPayment({ gatewayPaymentId: 'ORDER-GET-123' });

            expect(result.gatewayId).toBe('ORDER-GET-123');
            expect(result.orderId).toBe('ORDER-GET-123');
            expect(result.captureId).toBe('CAP-001');
            expect(result.status).toBe('paid');
            expect(moneyToMajorNumber(result.amount!)).toBe(200);
            // PAYPAL-1: currency dual-written with major-unit amount
            expect(result.currency).toBe('USD');
            expect(moneyToMajorNumber(result.capturedAmount!)).toBe(200);
            expect(result.outcome).toBe('succeeded');
            expect(isPaidOutcome(result)).toBe(true);
        });

        it('GET HTTP 200 empty or non-JSON throws GatewayApiError without inventing {} (S20-PAYPAL-JSON)', async () => {
            const cases = [
                ['', /empty body/i],
                ['<html>not json</html>', /invalid JSON/i],
            ] as const;
            for (const [body, message] of cases) {
                globalThis.fetch = createMockRawFetch(body);
                const error = await gateway.getPayment({
                    gatewayPaymentId: 'ORDER-JSON',
                }).then(
                    () => undefined,
                    (err: unknown) => err,
                );
                expect(error).toBeInstanceOf(GatewayApiError);
                expect((error as Error).message).toMatch(message);
                expect((error as Error).message).not.toMatch(/missing id/i);
            }
        });

        it('APPROVED order (pre-capture) is not isPaidOutcome / not succeeded', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-APPROVED-ONLY',
                status: 'APPROVED',
                purchase_units: [
                    {
                        amount: {
                            currency_code: 'USD',
                            value: '50.00',
                        },
                    },
                ],
            });

            const result = await gateway.getPayment({
                gatewayPaymentId: 'ORDER-APPROVED-ONLY',
            });

            expect(result.status).toBe('approved');
            expect(result.outcome).toBe('requires_action');
            expect(result.outcome).not.toBe('succeeded');
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('COMPLETED capture order is isPaidOutcome true', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-PAID-OUTCOME',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        amount: {
                            currency_code: 'USD',
                            value: '75.00',
                        },
                        payments: {
                            captures: [
                                {
                                    id: 'CAP-PAID-OUTCOME',
                                    status: 'COMPLETED',
                                    final_capture: true,
                                    amount: {
                                        currency_code: 'USD',
                                        value: '75.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.getPayment({
                gatewayPaymentId: 'ORDER-PAID-OUTCOME',
            });

            expect(result.status).toBe('paid');
            expect(result.outcome).toBe('succeeded');
            expect(isPaidOutcome(result)).toBe(true);
        });

        it('should retry transient getPayment failures', async () => {
            let orderFetchCount = 0;

            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                orderFetchCount++;
                if (orderFetchCount === 1) {
                    return createMockResponse(
                        {
                            name: 'INTERNAL_SERVER_ERROR',
                            message: 'Temporary failure',
                        },
                        false,
                        500
                    );
                }

                return createMockResponse({
                    id: 'ORDER-GET-RETRIED',
                    status: 'CREATED',
                    purchase_units: [
                        {
                            amount: {
                                currency_code: 'USD',
                                value: '12.00',
                            },
                        },
                    ],
                });
            }) as unknown as typeof fetch;

            const result = await gateway.getPayment({ gatewayPaymentId: 'ORDER-GET-RETRIED' });

            expect(result.gatewayId).toBe('ORDER-GET-RETRIED');
            expect(orderFetchCount).toBe(2);
        });

        it('should run global hooks for getPayment', async () => {
            let beforeOperation: string | undefined;
            let afterOperation: string | undefined;

            const hooksWithGlobal = new HooksManager({
                onBefore: async (ctx) => {
                    beforeOperation = ctx.operation;
                    return { proceed: true };
                },
                onAfter: async (ctx) => {
                    afterOperation = ctx.operation;
                    return { proceed: true };
                },
            });

            const gatewayWithHooks = new PayPalGateway(PAYPAL_TEST_CONFIG, hooksWithGlobal);

            globalThis.fetch = createMockFetch({
                id: 'ORDER-GET-HOOK',
                status: 'CREATED',
            });

            await gatewayWithHooks.getPayment({ gatewayPaymentId: 'ORDER-GET-HOOK' });

            expect(beforeOperation).toBe('getPayment');
            expect(afterOperation).toBe('getPayment');
        });

        it('should omit captureId on multi-capture and aggregate held amounts (PAYPAL-1)', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-MULTI-CAP',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        amount: {
                            currency_code: 'USD',
                            value: '100.00',
                        },
                        payments: {
                            captures: [
                                {
                                    id: 'CAP-OLD',
                                    status: 'COMPLETED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '40.00',
                                    },
                                },
                                {
                                    id: 'CAP-NEW',
                                    status: 'COMPLETED',
                                    final_capture: true,
                                    amount: {
                                        currency_code: 'USD',
                                        value: '60.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.getPayment({ gatewayPaymentId: 'ORDER-MULTI-CAP' });

            // PAYPAL-1: do not dual-write full aggregate with only latest captureId
            expect(result.captureId).toBeUndefined();
            expect(moneyToMajorNumber(result.amount!)).toBe(100);
            expect(moneyToMajorNumber(result.capturedAmount!)).toBe(100);
            expect(result.status).toBe('paid');
            expect(isPaidOutcome(result)).toBe(true);
        });

        it('multi-capture with REFUNDED sibling is not false paid; amounts exclude refunded face (PAYPAL-2)', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-MULTI-CAP-REFUND',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        amount: {
                            currency_code: 'USD',
                            value: '100.00',
                        },
                        payments: {
                            captures: [
                                {
                                    id: 'CAP-REFUNDED',
                                    status: 'REFUNDED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '40.00',
                                    },
                                },
                                {
                                    id: 'CAP-HELD',
                                    status: 'COMPLETED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '60.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.getPayment({
                gatewayPaymentId: 'ORDER-MULTI-CAP-REFUND',
            });

            // Latest COMPLETED must not force paid when a sibling is REFUNDED.
            expect(result.status).toBe('partially_refunded');
            expect(result.status).not.toBe('paid');
            expect(isPaidOutcome(result)).toBe(false);
            // Held remaining only — not original 100 including REFUNDED face.
            expect(moneyToMajorNumber(result.amount!)).toBe(60);
            expect(moneyToMajorNumber(result.capturedAmount!)).toBe(60);
            expect(moneyToMajorNumber(result.amount!)).not.toBe(100);
            // Exactly one refundable capture remains → honest single captureId.
            expect(result.captureId).toBe('CAP-HELD');
        });

        it('multi-capture all REFUNDED → refunded with zero held amount (PAYPAL-2)', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-ALL-REFUNDED',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        amount: {
                            currency_code: 'USD',
                            value: '100.00',
                        },
                        payments: {
                            captures: [
                                {
                                    id: 'CAP-R1',
                                    status: 'REFUNDED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '40.00',
                                    },
                                },
                                {
                                    id: 'CAP-R2',
                                    status: 'REFUNDED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '60.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.getPayment({
                gatewayPaymentId: 'ORDER-ALL-REFUNDED',
            });

            expect(result.status).toBe('refunded');
            expect(isPaidOutcome(result)).toBe(false);
            // No still-held captures → aggregate amount omitted (not false 100).
            expect(result.amount).toBeUndefined();
            expect(result.capturedAmount).toBeUndefined();
            expect(result.captureId).toBeUndefined();
        });

        it('PARTIALLY_REFUNDED capture alone does not report face amount as held (PAYPAL-2 fail-closed)', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-PARTIAL-REFUND-ONLY',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        amount: {
                            currency_code: 'USD',
                            value: '100.00',
                        },
                        payments: {
                            captures: [
                                {
                                    id: 'CAP-PARTIAL-REF',
                                    status: 'PARTIALLY_REFUNDED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '100.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.getPayment({
                gatewayPaymentId: 'ORDER-PARTIAL-REFUND-ONLY',
            });

            expect(result.status).toBe('partially_refunded');
            expect(isPaidOutcome(result)).toBe(false);
            // Face amount without net remaining → omit (do not claim full 100 held).
            expect(result.amount).toBeUndefined();
            expect(result.capturedAmount).toBeUndefined();
            // Still refundable (partial) — single id is honest.
            expect(result.captureId).toBe('CAP-PARTIAL-REF');
        });

        it('should not prefer COMPLETED capture over PARTIALLY_CAPTURED authorization (PAYPAL-2)', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-PARTIAL-AUTH-GET',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        amount: {
                            currency_code: 'USD',
                            value: '100.00',
                        },
                        payments: {
                            captures: [
                                {
                                    id: 'CAP-SLICE',
                                    status: 'COMPLETED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '25.00',
                                    },
                                    final_capture: false,
                                },
                            ],
                            authorizations: [
                                {
                                    id: 'AUTH-OPEN',
                                    status: 'PARTIALLY_CAPTURED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '100.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.getPayment({
                gatewayPaymentId: 'ORDER-PARTIAL-AUTH-GET',
            });

            expect(result.status).toBe('partially_captured');
            expect(result.captureId).toBe('CAP-SLICE');
            expect(result.authorizationId).toBe('AUTH-OPEN');
            expect(moneyToMajorNumber(result.amount!)).toBe(25);
            expect(moneyToMajorNumber(result.capturedAmount!)).toBe(25);
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('getPayment matching totals without final_capture is not paid (NEW-PAYPAL-3)', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-OMITTED-FINAL',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        amount: {
                            currency_code: 'USD',
                            value: '40.00',
                        },
                        payments: {
                            captures: [
                                {
                                    id: 'CAP-OMITTED-FINAL',
                                    status: 'COMPLETED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '40.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.getPayment({
                gatewayPaymentId: 'ORDER-OMITTED-FINAL',
            });

            expect(result.status).toBe('partially_captured');
            expect(result.status).not.toBe('paid');
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('should map multi-capture under order total to partially_captured', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-UNDER-TOTAL',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        amount: {
                            currency_code: 'USD',
                            value: '100.00',
                        },
                        payments: {
                            captures: [
                                {
                                    id: 'CAP-A',
                                    status: 'COMPLETED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '40.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.getPayment({
                gatewayPaymentId: 'ORDER-UNDER-TOTAL',
            });

            expect(result.status).toBe('partially_captured');
            expect(moneyToMajorNumber(result.amount!)).toBe(40);
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('should retrieve capture details when gatewayPaymentId is a PayPal capture ID', async () => {
            const requestedUrls: string[] = [];

            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;
                requestedUrls.push(url);

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('/v2/checkout/orders/CAP-LOOKUP-123')) {
                    return createMockResponse(
                        {
                            name: 'RESOURCE_NOT_FOUND',
                            message: 'Order not found',
                        },
                        false,
                        404
                    );
                }

                return createMockResponse({
                    id: 'CAP-LOOKUP-123',
                    status: 'COMPLETED',
                    final_capture: true,
                    amount: {
                        currency_code: 'USD',
                        value: '44.00',
                    },
                    supplementary_data: {
                        related_ids: {
                            order_id: 'ORDER-FOR-CAPTURE',
                            authorization_id: 'AUTH-FOR-CAPTURE',
                        },
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.getPayment({ gatewayPaymentId: 'CAP-LOOKUP-123' });

            expect(result.gatewayId).toBe('CAP-LOOKUP-123');
            expect(result.captureId).toBe('CAP-LOOKUP-123');
            expect(result.orderId).toBe('ORDER-FOR-CAPTURE');
            expect(result.authorizationId).toBe('AUTH-FOR-CAPTURE');
            expect(result.status).toBe('paid');
            expect(moneyToMajorNumber(result.amount!)).toBe(44);
            expect(result.currency).toBe('USD');
            expect(requestedUrls.some((url) => url.includes('/v2/payments/captures/CAP-LOOKUP-123'))).toBe(true);
        });

        it('capture GET after PARTIALLY_REFUNDED omits face amount without net remaining (PAYPAL-3)', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('/v2/checkout/orders/CAP-PARTIAL-REF')) {
                    return createMockResponse(
                        { name: 'RESOURCE_NOT_FOUND', message: 'Order not found' },
                        false,
                        404,
                    );
                }

                return createMockResponse({
                    id: 'CAP-PARTIAL-REF',
                    status: 'PARTIALLY_REFUNDED',
                    amount: {
                        currency_code: 'USD',
                        value: '100.00',
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.getPayment({
                gatewayPaymentId: 'CAP-PARTIAL-REF',
            });

            expect(result.status).toBe('partially_refunded');
            // Face without net remaining → omit (do not claim 100 still held).
            expect(result.amount).toBeUndefined();
            expect(result.currency).toBeUndefined();
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('capture GET after PARTIALLY_REFUNDED publishes net remaining when breakdown present (PAYPAL-3)', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('/v2/checkout/orders/CAP-PARTIAL-NET')) {
                    return createMockResponse(
                        { name: 'RESOURCE_NOT_FOUND', message: 'Order not found' },
                        false,
                        404,
                    );
                }

                return createMockResponse({
                    id: 'CAP-PARTIAL-NET',
                    status: 'PARTIALLY_REFUNDED',
                    amount: {
                        currency_code: 'USD',
                        value: '100.00',
                    },
                    seller_receivable_breakdown: {
                        total_refunded_amount: {
                            currency_code: 'USD',
                            value: '30.00',
                        },
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.getPayment({
                gatewayPaymentId: 'CAP-PARTIAL-NET',
            });

            expect(result.status).toBe('partially_refunded');
            expect(moneyToMajorNumber(result.amount!)).toBe(70);
            expect(result.currency).toBe('USD');
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('capture GET remaining held uses bigint minors not float subtract (PAYPAL-2)', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('/v2/checkout/orders/CAP-FLOAT-TRAP')) {
                    return createMockResponse(
                        { name: 'RESOURCE_NOT_FOUND', message: 'Order not found' },
                        false,
                        404,
                    );
                }

                return createMockResponse({
                    id: 'CAP-FLOAT-TRAP',
                    status: 'PARTIALLY_REFUNDED',
                    amount: {
                        currency_code: 'USD',
                        value: '1.03',
                    },
                    seller_receivable_breakdown: {
                        total_refunded_amount: {
                            currency_code: 'USD',
                            value: '0.42',
                        },
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.getPayment({
                gatewayPaymentId: 'CAP-FLOAT-TRAP',
            });

            expect(result.status).toBe('partially_refunded');
            // 103 - 42 = 61 cents → exact 0.61 major (not float residue).
            expect(moneyToMajorNumber(result.amount!)).toBe(0.61);
            expect(result.currency).toBe('USD');
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('capture GET face equals total_refunded → remainingMinor 0n omits held (PAYPAL-2)', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('/v2/checkout/orders/CAP-ZERO-REMAINING')) {
                    return createMockResponse(
                        { name: 'RESOURCE_NOT_FOUND', message: 'Order not found' },
                        false,
                        404,
                    );
                }

                return createMockResponse({
                    id: 'CAP-ZERO-REMAINING',
                    status: 'PARTIALLY_REFUNDED',
                    amount: {
                        currency_code: 'USD',
                        value: '25.00',
                    },
                    seller_receivable_breakdown: {
                        total_refunded_amount: {
                            currency_code: 'USD',
                            value: '25.00',
                        },
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.getPayment({
                gatewayPaymentId: 'CAP-ZERO-REMAINING',
            });

            expect(result.status).toBe('partially_refunded');
            // Exact zero remaining on minor bigint → no still-held face amount.
            expect(result.amount).toBeUndefined();
            expect(result.currency).toBeUndefined();
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('multi-capture REFUNDED + PENDING sibling is partially_refunded not refunded (PAYPAL-3)', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-REFUNDED-PENDING',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        amount: {
                            currency_code: 'USD',
                            value: '100.00',
                        },
                        payments: {
                            captures: [
                                {
                                    id: 'CAP-REFUNDED-SIB',
                                    status: 'REFUNDED',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '40.00',
                                    },
                                },
                                {
                                    id: 'CAP-PENDING-SIB',
                                    status: 'PENDING',
                                    amount: {
                                        currency_code: 'USD',
                                        value: '60.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.getPayment({
                gatewayPaymentId: 'ORDER-REFUNDED-PENDING',
            });

            expect(result.status).toBe('partially_refunded');
            expect(result.status).not.toBe('refunded');
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('capture GET after REFUNDED omits face amount (PAYPAL-3)', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('/v2/checkout/orders/CAP-FULL-REF')) {
                    return createMockResponse(
                        { name: 'RESOURCE_NOT_FOUND', message: 'Order not found' },
                        false,
                        404,
                    );
                }

                return createMockResponse({
                    id: 'CAP-FULL-REF',
                    status: 'REFUNDED',
                    amount: {
                        currency_code: 'USD',
                        value: '100.00',
                    },
                    seller_receivable_breakdown: {
                        total_refunded_amount: {
                            currency_code: 'USD',
                            value: '100.00',
                        },
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.getPayment({
                gatewayPaymentId: 'CAP-FULL-REF',
            });

            expect(result.status).toBe('refunded');
            expect(result.amount).toBeUndefined();
            expect(result.currency).toBeUndefined();
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('capture GET after REVERSED omits face amount (audit PAYPAL-1)', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('/v2/checkout/orders/CAP-REVERSED')) {
                    return createMockResponse(
                        { name: 'RESOURCE_NOT_FOUND', message: 'Order not found' },
                        false,
                        404,
                    );
                }

                return createMockResponse({
                    id: 'CAP-REVERSED',
                    status: 'REVERSED',
                    amount: {
                        currency_code: 'USD',
                        value: '88.00',
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.getPayment({
                gatewayPaymentId: 'CAP-REVERSED',
            });

            expect(result.status).toBe('reversed');
            // Full clawback: do not report original face as still-held.
            expect(result.amount).toBeUndefined();
            expect(result.currency).toBeUndefined();
            // P610-PP-1: reversal is not a successful charge outcome.
            expect(result.outcome).not.toBe('succeeded');
            expect(result.outcome).toBe('failed');
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('getPayment by capture ID missing final_capture is not paid (NEW-PAYPAL-3)', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('/v2/checkout/orders/CAP-OMITTED-FINAL-GET')) {
                    return createMockResponse(
                        {
                            name: 'RESOURCE_NOT_FOUND',
                            message: 'Order not found',
                        },
                        false,
                        404
                    );
                }

                return createMockResponse({
                    id: 'CAP-OMITTED-FINAL-GET',
                    status: 'COMPLETED',
                    amount: {
                        currency_code: 'USD',
                        value: '20.00',
                    },
                    supplementary_data: {
                        related_ids: {
                            order_id: 'ORDER-OPEN-AUTH-OMITTED',
                            authorization_id: 'AUTH-OPEN-OMITTED',
                        },
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.getPayment({
                gatewayPaymentId: 'CAP-OMITTED-FINAL-GET',
            });

            expect(result.status).toBe('partially_captured');
            expect(result.status).not.toBe('paid');
            expect(result.outcome).toBe('requires_action');
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('getPayment by capture ID with final_capture false → partially_captured not paid (PAYPAL-1 audit)', async () => {
            // capturePayment returns gatewayId = capture.id; re-poll by that id must
            // not over-promote non-final COMPLETED captures to paid / isPaidOutcome.
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (url.includes('/v2/checkout/orders/CAP-NONFINAL-GET')) {
                    return createMockResponse(
                        {
                            name: 'RESOURCE_NOT_FOUND',
                            message: 'Order not found',
                        },
                        false,
                        404
                    );
                }

                return createMockResponse({
                    id: 'CAP-NONFINAL-GET',
                    status: 'COMPLETED',
                    final_capture: false,
                    amount: {
                        currency_code: 'USD',
                        value: '20.00',
                    },
                    supplementary_data: {
                        related_ids: {
                            order_id: 'ORDER-OPEN-AUTH',
                            authorization_id: 'AUTH-OPEN',
                        },
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.getPayment({
                gatewayPaymentId: 'CAP-NONFINAL-GET',
            });

            expect(result.gatewayId).toBe('CAP-NONFINAL-GET');
            expect(result.captureId).toBe('CAP-NONFINAL-GET');
            expect(result.orderId).toBe('ORDER-OPEN-AUTH');
            expect(result.authorizationId).toBe('AUTH-OPEN');
            expect(result.status).toBe('partially_captured');
            expect(moneyToMajorNumber(result.amount!)).toBe(20);
            expect(result.currency).toBe('USD');
            expect(result.outcome).toBe('requires_action');
            expect(result.outcome).not.toBe('succeeded');
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('should retrieve authorization details when gatewayPaymentId is a PayPal authorization ID', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (
                    url.includes('/v2/checkout/orders/AUTH-LOOKUP-123') ||
                    url.includes('/v2/payments/captures/AUTH-LOOKUP-123')
                ) {
                    return createMockResponse(
                        {
                            name: 'RESOURCE_NOT_FOUND',
                            message: 'Resource not found',
                        },
                        false,
                        404
                    );
                }

                return createMockResponse({
                    id: 'AUTH-LOOKUP-123',
                    status: 'CREATED',
                    amount: {
                        currency_code: 'USD',
                        value: '55.00',
                    },
                    supplementary_data: {
                        related_ids: {
                            order_id: 'ORDER-FOR-AUTHORIZATION',
                        },
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.getPayment({ gatewayPaymentId: 'AUTH-LOOKUP-123' });

            expect(result.gatewayId).toBe('AUTH-LOOKUP-123');
            expect(result.authorizationId).toBe('AUTH-LOOKUP-123');
            expect(result.orderId).toBe('ORDER-FOR-AUTHORIZATION');
            expect(result.status).toBe('authorized');
            expect(moneyToMajorNumber(result.amount!)).toBe(55);
        });

        it('authorization GET omits related_ids.capture_id when siblings cannot be proven (NEW-PAYPAL-5)', async () => {
            globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                const url = typeof input === 'string' ? input : (input as Request).url;

                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                if (
                    url.includes('/v2/checkout/orders/AUTH-LOOKUP-CAPTURE-ID') ||
                    url.includes('/v2/payments/captures/AUTH-LOOKUP-CAPTURE-ID')
                ) {
                    return createMockResponse(
                        {
                            name: 'RESOURCE_NOT_FOUND',
                            message: 'Resource not found',
                        },
                        false,
                        404
                    );
                }

                return createMockResponse({
                    id: 'AUTH-LOOKUP-CAPTURE-ID',
                    status: 'CAPTURED',
                    amount: {
                        currency_code: 'USD',
                        value: '55.00',
                    },
                    supplementary_data: {
                        related_ids: {
                            order_id: 'ORDER-FOR-AUTHORIZATION-CAP',
                            capture_id: 'CAP-RELATED-UNPROVEN',
                        },
                    },
                });
            }) as unknown as typeof fetch;

            const result = await gateway.getPayment({
                gatewayPaymentId: 'AUTH-LOOKUP-CAPTURE-ID',
            });

            expect(result.gatewayId).toBe('AUTH-LOOKUP-CAPTURE-ID');
            expect(result.authorizationId).toBe('AUTH-LOOKUP-CAPTURE-ID');
            expect(result.orderId).toBe('ORDER-FOR-AUTHORIZATION-CAP');
            expect(result.captureId).toBeUndefined();
            expect(result.captureId).not.toBe('CAP-RELATED-UNPROVEN');
        });

        it('getPayment ORDER.COMPLETED without totals is not paid (NEW-PAYPAL-6)', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-NO-TOTALS',
                status: 'COMPLETED',
                purchase_units: [
                    {
                        payments: {
                            captures: [
                                {
                                    id: 'CAP-NO-TOTAL',
                                    status: 'COMPLETED',
                                    final_capture: true,
                                    amount: {
                                        currency_code: 'USD',
                                        value: '40.00',
                                    },
                                },
                            ],
                        },
                    },
                ],
            });

            const result = await gateway.getPayment({
                gatewayPaymentId: 'ORDER-NO-TOTALS',
            });

            expect(result.status).toBe('partially_captured');
            expect(result.status).not.toBe('paid');
            expect(isPaidOutcome(result)).toBe(false);
        });

        it('bare COMPLETED order without captures is not isPaidOutcome (PAYPAL-1)', async () => {
            globalThis.fetch = createMockFetch({
                id: 'ORDER-BARE-COMPLETED',
                status: 'COMPLETED',
                // No purchase_units.payments.captures / authorizations
            });

            const result = await gateway.getPayment({
                gatewayPaymentId: 'ORDER-BARE-COMPLETED',
            });

            expect(result.status).toBe('processing');
            expect(result.status).not.toBe('paid');
            expect(result.outcome).not.toBe('succeeded');
            expect(isPaidOutcome(result)).toBe(false);
        });

        describe('getPaymentStatus', () => {
            it('bare COMPLETED order without captures is not paid (PAYPAL-1)', async () => {
                globalThis.fetch = createMockFetch({
                    id: 'ORDER-123',
                    status: 'COMPLETED',
                });

                const status = await gateway.getPaymentStatus('ORDER-123');
                // Fail-closed: order COMPLETED without payments.captures must not look settled.
                expect(status).toBe('processing');
                expect(status).not.toBe('paid');
            });

            it('should return status for capture IDs returned as capturePayment gatewayId', async () => {
                globalThis.fetch = mock(async (input: RequestInfo | URL) => {
                    const url = typeof input === 'string' ? input : (input as Request).url;

                    if (url.includes('oauth2/token')) {
                        return createMockResponse({
                            access_token: 'test_token',
                            expires_in: 3600,
                        });
                    }

                    if (url.includes('/v2/checkout/orders/CAP-STATUS-123')) {
                        return createMockResponse(
                            {
                                name: 'RESOURCE_NOT_FOUND',
                                message: 'Order not found',
                            },
                            false,
                            404
                        );
                    }

                    return createMockResponse({
                        id: 'CAP-STATUS-123',
                        status: 'COMPLETED',
                        final_capture: true,
                        amount: {
                            currency_code: 'USD',
                            value: '12.00',
                        },
                    });
                }) as unknown as typeof fetch;

                const status = await gateway.getPaymentStatus('CAP-STATUS-123');
                expect(status).toBe('paid');
            });
        });
    });

    describe('Abort and timeout (P610-ABT-4)', () => {
        it('should time out while reading a hanging PayPal response body', async () => {
            const timeoutGateway = new PayPalGateway(
                { ...PAYPAL_TEST_CONFIG, timeoutMs: 1 },
                hooksManager,
            );

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;
                if (url.includes('oauth2/token')) {
                    return createMockResponse({
                        access_token: 'test_token',
                        expires_in: 3600,
                    });
                }

                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: new Headers(),
                    text: async () =>
                        new Promise<string>((_resolve, reject) => {
                            init?.signal?.addEventListener('abort', () => {
                                reject(new DOMException('Aborted', 'AbortError'));
                            });
                        }),
                } as unknown as Response;
            }) as unknown as typeof fetch;

            const hungBody = await timeoutGateway.createPayment({
                amount: money(10, "USD"),
                currency: 'USD',
                callbackUrl: 'https://example.com',
            });
            expect(hungBody.outcome).toBe('indeterminate');
            expect(hungBody.reconciliationRequired).toBe(true);
        });

        it('should thread caller AbortSignal into token acquisition', async () => {
            let tokenSawCallerAbort = false;

            globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : (input as Request).url;
                if (url.includes('oauth2/token')) {
                    tokenSawCallerAbort = init?.signal?.aborted === true;
                    if (init?.signal?.aborted) {
                        throw new DOMException('Aborted', 'AbortError');
                    }
                    return createMockResponse({
                        access_token: 'should_not_issue',
                        expires_in: 3600,
                    });
                }
                return createMockResponse({
                    id: 'ORDER-SHOULD-NOT-RUN',
                    status: 'CREATED',
                });
            }) as unknown as typeof fetch;

            const controller = new AbortController();
            controller.abort();

            await expect(
                gateway.createPayment({
                    amount: money(10, "USD"),
                    currency: 'USD',
                    callbackUrl: 'https://example.com',
                    signal: controller.signal,
                }),
            ).rejects.toBeInstanceOf(PaymentAbortedError);
            expect(tokenSawCallerAbort).toBe(true);
        });
    });
});
