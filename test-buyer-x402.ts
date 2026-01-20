import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

async function main() {
    let privateKey = process.env.EVM_PRIVATE_KEY;
    if (!privateKey) {
        console.error("EVM_PRIVATE_KEY environment variable is required");
        process.exit(1);
    }

    // Ensure 0x prefix for viem
    if (!privateKey.startsWith("0x")) {
        privateKey = `0x${privateKey}`;
    }

    const testUrl = process.env.TEST_URL || "http://localhost:3000/bzz/test-endpoint";
    console.log(`Starting x402 buyer test...`);
    console.log(`Target URL: ${testUrl}`);

    // Create signer
    const signer = privateKeyToAccount(privateKey as `0x${string}`);
    console.log(`Using wallet address: ${signer.address}`);

    // Create x402 client and register schemes
    const client = new x402Client();

    // Create public client for dynamic domain resolution
    const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(),
    });

    // Register the EVM exact scheme
    // Note: The signer will be used to sign the payment proof
    registerExactEvmScheme(client, { signer });

    // Register a hook for dynamic domain resolution
    // This allows the client to fetch EIP-712 domain metadata (name, version)
    // from the blockchain if the server doesn't provide it in the requirements.
    client.onBeforePaymentCreation(async (context) => {
        const req = context.selectedRequirements as any;
        if (req.network?.startsWith("eip155:") && (!req.extra?.name || !req.extra?.version)) {
            console.log(`Dynamic resolution: Fetching domain metadata for asset ${req.asset}...`);
            try {
                const [name, version] = await Promise.all([
                    publicClient.readContract({
                        address: req.asset as `0x${string}`,
                        abi: [{ name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }],
                        functionName: "name",
                    }),
                    publicClient.readContract({
                        address: req.asset as `0x${string}`,
                        abi: [{ name: "version", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }],
                        functionName: "version",
                    }),
                ]);
                console.log(`Resolved: name="${name}", version="${version}"`);
                req.extra = { ...req.extra, name, version };
                // Also update the domain object if expected by the scheme
                req.domain = { ...req.domain, name, version };
            } catch (err) {
                console.error("Failed to resolve domain metadata:", err);
            }
        }
    });

    // Wrap fetch with payment handling
    // This wrapper automatically intercepts 402 responses,
    // coordinates payment, and retries the request with proof.
    const fetchWithPayment = wrapFetchWithPayment(fetch, client);

    try {
        console.log("Making request...");
        const response = await fetchWithPayment(testUrl, {
            method: "GET",
        });

        console.log(`Status: ${response.status} ${response.statusText}`);

        const body = await response.text();
        console.log("Response Body:", body);

        if (response.status === 200) {
            // Payment succeeded! Try to get the settlement receipt
            const httpClient = new x402HTTPClient(client);
            try {
                const paymentResponse = httpClient.getPaymentSettleResponse(
                    (name) => response.headers.get(name)
                );
                console.log("✅ Payment settled successfully!");
                console.log("Payment Receipt:", JSON.stringify(paymentResponse, null, 2));
            } catch {
                console.log("✅ Request succeeded (no settlement header - might be free endpoint)");
            }
        } else if (response.status === 402) {
            // Still 402 after retry - payment verification likely failed
            console.log("\n⚠️ Payment verification failed on the server side.");
            console.log("This usually means:");
            console.log("  1. The facilitator couldn't verify the payment on-chain");
            console.log("  2. The wallet doesn't have sufficient USDC balance");
            console.log("  3. The signature was invalid");
            console.log("\nResponse headers:");
            response.headers.forEach((value, key) => {
                if (key.toLowerCase().includes('payment') || key.toLowerCase().includes('x402')) {
                    console.log(`  ${key}: ${value.substring(0, 80)}${value.length > 80 ? '...' : ''}`);
                }
            });
        } else {
            console.log(`Unexpected response status: ${response.status}`);
        }
    } catch (error) {
        if (error instanceof Error) {
            if (error.message.includes("No scheme registered")) {
                console.error("Network not supported - register the appropriate scheme");
            } else if (error.message.includes("Payment already attempted")) {
                console.error("Payment failed on retry (already attempted)");
            } else {
                console.error("Request failed:", error.message);
            }
        } else {
            console.error("An unknown error occurred:", error);
        }
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
