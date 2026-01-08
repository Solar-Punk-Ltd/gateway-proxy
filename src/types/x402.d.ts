declare module '@coinbase/x402';

declare module '@x402/core/server' {
    export interface HTTPAdapter {
        getHeader(name: string): string | undefined;
        getMethod(): string;
        getPath(): string;
        getUrl(): string;
        getAcceptHeader(): string;
        getUserAgent(): string;
        getQueryParams(): Record<string, string | string[]>;
        getQueryParam(name: string): string | string[] | undefined;
    }

    export interface RoutesConfig {
        [key: string]: any;
    }

    export interface HTTPRequestContext {
        adapter: HTTPAdapter;
        path: string;
        method: string;
        paymentHeader?: string;
    }

    export class x402HTTPResourceServer {
        constructor(resourceServer: any, routes: RoutesConfig);
        initialize(): Promise<void>;
        processHTTPRequest(context: HTTPRequestContext): Promise<any>;
        processSettlement(payload: any, requirements: any): Promise<any>;
    }

    export class x402ResourceServer {
        constructor(client: any);
        register(network: string, client: any): void;
    }

    export class HTTPFacilitatorClient {
        constructor(config: any);
    }
}
