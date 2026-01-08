/// <reference path="./types/x402.d.ts" />
import { createFacilitatorConfig } from '@coinbase/x402'
import {
    x402HTTPResourceServer,
    x402ResourceServer,
    HTTPFacilitatorClient,
    RoutesConfig,
    HTTPRequestContext,
    HTTPAdapter
} from '@x402/core/server'
import { NextFunction, Request, Response } from 'express'
import { AppConfig } from './config'
import { logger } from './logger'

logger.info('x402: Module loaded');

/**
 * Converts a decimal amount to atomic integer units based on decimals (default 6 for USDC).
 */
function toAtomicUnits(value: string | number | undefined, decimals: number = 6): string {
    if (value === undefined || value === '') return '0';
    const valStr = String(value).trim();
    if (!valStr.includes('.')) {
        return (BigInt(valStr) * BigInt(10 ** decimals)).toString();
    }
    const [integerPart, fractionalPart] = valStr.split('.');
    const fractionalPadded = fractionalPart.padEnd(decimals, '0').slice(0, decimals);
    return BigInt((integerPart || '0') + fractionalPadded).toString();
}

class ExpressAdapter implements HTTPAdapter {
    constructor(private req: Request) { }

    getHeader(name: string): string | undefined {
        const lowerName = name.toLowerCase()
        const headerVal = this.req.headers[lowerName]
        if (Array.isArray(headerVal)) return headerVal[0]
        return headerVal
    }

    getMethod(): string {
        return this.req.method
    }

    getPath(): string {
        return this.req.path
    }

    getUrl(): string {
        const protocol = this.req.protocol
        const host = this.req.get('host')
        return `${protocol}://${host}${this.req.originalUrl}`
    }

    getAcceptHeader(): string {
        return this.req.get('accept') || ''
    }

    getUserAgent(): string {
        return this.req.get('user-agent') || ''
    }

    getQueryParams(): Record<string, string | string[]> {
        return this.req.query as Record<string, string | string[]>
    }

    getQueryParam(name: string): string | string[] | undefined {
        return this.req.query[name] as string | string[] | undefined
    }
}

export class X402PaymentService {
    private server?: x402HTTPResourceServer
    private config: AppConfig

    constructor(config: AppConfig) {
        this.config = config

        const getDomain = (name?: string, version?: string) => ({
            name: (name && name !== 'undefined') ? name : 'USDC',
            version: (version && version !== 'undefined') ? version : '2'
        });

        const domain = getDomain(config.x402UsdcDomainName, config.x402UsdcDomainVersion);
        const network = config.x402Network || 'eip155:8453'
        const isTestnet = network === 'eip155:84532'
        const payTo = config.x402WalletAddress || '0x0000000000000000000000000000000000000000'
        const asset = config.x402UsdcAsset || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

        logger.info('Initializing x402 payment service', {
            network,
            asset,
            domainName: domain.name,
            domainVersion: domain.version
        })

        if (!config.cdpApiKeyId || !config.cdpApiKeySecret) {
            logger.warn('CDP API keys missing (required for x402 verification).')
            return
        }

        let facilitatorClient: HTTPFacilitatorClient
        if (isTestnet) {
            logger.info('x402: Using x402.org testnet facilitator')
            facilitatorClient = new HTTPFacilitatorClient({ url: 'https://x402.org/facilitator' })
        } else {
            logger.info('x402: Using CDP mainnet facilitator')
            const facilitatorConfig = createFacilitatorConfig(config.cdpApiKeyId, config.cdpApiKeySecret)
            facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig)
        }

        // Configure facilitator capabilities for any compatible asset
        ; (facilitatorClient as any).scheme = 'exact'
            ; (facilitatorClient as any).parsePrice = (amount: any) => amount
            ; (facilitatorClient as any).enhancePaymentRequirements = async (requirements: any) => {
                const reqArray = Array.isArray(requirements) ? requirements : [requirements]
                for (const req of reqArray) {
                    // Apply domain and extra parameters if missing
                    if (!req.domain || !req.extra?.name) {
                        req.domain = domain
                        req.extra = { ...req.extra, ...domain }
                    }

                    // Ensure atomic units for decimal prices
                    const amount = req.amount || req.price?.amount
                    if (amount && String(amount).includes('.')) {
                        const atomicAmount = toAtomicUnits(amount)
                        if (req.price) req.price.amount = atomicAmount
                        if (req.amount) req.amount = atomicAmount
                    }
                }
                return requirements
            }

        const resourceServer = new x402ResourceServer(facilitatorClient)
        resourceServer.register(network, facilitatorClient)

        const routes: RoutesConfig = {}
        const defaultRequirement = {
            scheme: 'exact',
            network,
            payTo,
            domain,
            extra: domain
        }

        if (config.x402GlobalPrice) {
            routes['*'] = {
                accepts: {
                    ...defaultRequirement,
                    price: {
                        amount: toAtomicUnits(config.x402GlobalPrice),
                        asset
                    }
                }
            }
        }

        if (config.x402Prices) {
            for (const [path, price] of Object.entries(config.x402Prices)) {
                routes[path] = {
                    accepts: {
                        ...defaultRequirement,
                        price: {
                            amount: toAtomicUnits(price),
                            asset
                        }
                    }
                }
            }
        }

        this.server = new x402HTTPResourceServer(resourceServer, routes)
        this.server.initialize().catch((err: any) => {
            logger.error('Failed to initialize x402 server', err)
        })
    }

    public middleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        if (!this.server) {
            next()
            return
        }

        const adapter = new ExpressAdapter(req)
        const paymentHeader = adapter.getHeader('payment-signature')
        const context: HTTPRequestContext = {
            adapter,
            path: adapter.getPath(),
            method: adapter.getMethod(),
            paymentHeader
        }

        try {
            const result = await this.server.processHTTPRequest(context)

            if (result.type === 'no-payment-required') {
                next()
                return
            }

            if (result.type === 'payment-verified') {
                try {
                    const settlement = await this.server.processSettlement(result.paymentPayload, result.paymentRequirements)
                    if (settlement.success) {
                        logger.info('x402: payment settlement succeeded', { path: req.path });
                        if (settlement.headers) {
                            res.set(settlement.headers)
                        }
                    } else {
                        logger.error('x402: payment settlement failed', {
                            error: settlement.errorReason,
                            path: req.path
                        })
                    }
                } catch (settleErr: any) {
                    logger.error('x402: payment settlement exception', {
                        message: settleErr.message,
                        path: req.path
                    })
                }

                next()
                return
            }

            if (result.type === 'payment-error' && result.response) {
                const headers: Record<string, string> = {};
                if (result.response.headers) {
                    for (const [key, value] of Object.entries(result.response.headers)) {
                        headers[key.toLowerCase()] = value as string;
                    }
                }

                const domain = {
                    name: (this.config.x402UsdcDomainName && this.config.x402UsdcDomainName !== 'undefined') ? this.config.x402UsdcDomainName : 'USDC',
                    version: (this.config.x402UsdcDomainVersion && this.config.x402UsdcDomainVersion !== 'undefined') ? this.config.x402UsdcDomainVersion : '2'
                };

                let requirements: any[] = [];
                let payload: any = null;

                if (headers['payment-required']) {
                    try {
                        payload = JSON.parse(Buffer.from(headers['payment-required'], 'base64').toString('utf8'));
                        if (payload.accepts) requirements = payload.accepts;
                    } catch (e) { }
                } else if (headers['payment-requirements']) {
                    try {
                        requirements = JSON.parse(headers['payment-requirements']);
                        if (!Array.isArray(requirements)) requirements = [requirements];
                    } catch (e) { }
                }

                if (requirements.length > 0) {
                    let modified = false;
                    for (const reqItem of requirements) {
                        // Apply generic enhancements to all assets
                        if (!reqItem.extra?.name || !reqItem.extra?.version) {
                            reqItem.extra = { ...reqItem.extra, ...domain };
                            reqItem.domain = domain;
                            modified = true;
                        }
                        const amount = reqItem.amount || reqItem.price?.amount;
                        if (amount && String(amount).includes('.')) {
                            const atomic = toAtomicUnits(amount);
                            if (reqItem.price) reqItem.price.amount = atomic;
                            if (reqItem.amount) reqItem.amount = atomic;
                            modified = true;
                        }
                    }

                    if (modified) {
                        headers['payment-requirements'] = JSON.stringify(requirements);
                        if (payload) {
                            payload.accepts = requirements;
                            headers['payment-required'] = Buffer.from(JSON.stringify(payload)).toString('base64');
                        } else {
                            headers['payment-required'] = Buffer.from(JSON.stringify({
                                x402Version: 2,
                                error: "Payment required",
                                resource: { url: adapter.getUrl(), description: "", mimeType: "" },
                                accepts: requirements
                            })).toString('base64');
                        }
                    }
                }

                res.set(headers)
                res.status(result.response.status || 402)
                if (result.response.body) {
                    res.send(result.response.body)
                } else {
                    res.end()
                }
                return
            }

        } catch (error: any) {
            logger.error('x402 middleware error', error)
            res.status(500).send('Internal Server Error')
        }
    }
}
