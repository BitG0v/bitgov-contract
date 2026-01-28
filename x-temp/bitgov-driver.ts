/**
 * BitGov driver script
 *      -- run the script with --
 *  npx tsx x-temp/bitgov-driver.ts
 *
 * or with options:
 *
 *  npx tsx x-temp/bitgov-driver.ts --fast (ignores the delay time set)
 *  npx tsx x-temp/bitgov-driver.ts --mode=counter (test counter increment)
 *  npx tsx x-temp/bitgov-driver.ts --mode=decrement (test counter decrement)
 *  npx tsx x-temp/bitgov-driver.ts --mode=propose (test proposal creation)
 *  npx tsx x-temp/bitgov-driver.ts --mode=vote (test voting on proposals)
 *  npx tsx x-temp/bitgov-driver.ts --mode=execute (test proposal execution)
 *  npx tsx x-temp/bitgov-driver.ts --mode=full (test complete governance lifecycle)
 *
 * - Reads the deployer "mnemonic" from settings/Mainnet.toml
 * - Derives the account private key
 * - Interacts with the deployed mainnet contract
 * - Modes:
 *     counter: Continuously calls increment with random delays
 *     decrement: Continuously calls decrement with random delays
 *     propose: Creates proposals with random details
 *     vote: Votes on existing proposals
 *     execute: Executes passed proposals
 *     full: Runs complete governance flow with status checks
 * - Waits a random interval between each call:
 *     10s, 20s, 30s, 40s (configurable)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNetwork, TransactionVersion } from "@stacks/network";
import {
    AnchorMode,
    PostConditionMode,
    makeContractCall,
    broadcastTransaction,
    fetchCallReadOnlyFunction,
    cvToString,
    uintCV,
    boolCV,
    stringAsciiCV,
    stringUtf8CV,
} from "@stacks/transactions";
import { generateWallet, getStxAddress } from "@stacks/wallet-sdk";
import * as TOML from "toml";

type NetworkSettings = {
    network?: {
        name?: string;
        stacks_node_rpc_address?: string;
        deployment_fee_rate?: number;
    };
    accounts?: {
        deployer?: {
            mnemonic?: string;
        };
    };
};

// UPDATE THESE WITH YOUR DEPLOYED CONTRACT DETAILS
const CONTRACT_ADDRESS = "SP1GNDB8SXJ51GBMSVVXMWGTPRFHGSMWNNBEY25A4"; // Update after deployment
const CONTRACT_NAME = "bitgov";

// Function names in bitgov.clar
const FN_INCREMENT = "increment";
const FN_DECREMENT = "decrement";
const FN_CREATE_PROPOSAL = "create-proposal";
const FN_VOTE = "vote";
const FN_EXECUTE_PROPOSAL = "execute-proposal";
const FN_GET_COUNTER = "get-general-counter";
const FN_GET_PROPOSAL = "get-proposal";
const FN_GET_PROPOSAL_COUNT = "get-signature-count";

// Reasonable default fee in microstacks for contract-call
const DEFAULT_FEE_USTX = 10000;

// Parse command-line arguments
const FAST = process.argv.includes("--fast");
const MODE =
    process.argv.find((arg) => arg.startsWith("--mode="))?.split("=")[1] ||
    "counter";

// Random delay choices (milliseconds)
let DELAY_CHOICES_MS = [
    10_000, // 10 sec
    20_000, // 20 sec
    30_000, // 30 sec
    40_000, // 40 sec
];
if (FAST) {
    // Shorten delays for a quick smoke run
    DELAY_CHOICES_MS = [1_000, 2_000, 3_000, 5_000];
}

// Helper to get current file dir (ESM-compatible)
function thisDirname(): string {
    const __filename = fileURLToPath(import.meta.url);
    return path.dirname(__filename);
}

async function readMainnetMnemonic(): Promise<string> {
    const baseDir = thisDirname();
    // Resolve ../settings/Mainnet.toml relative to this file
    const settingsPath = path.resolve(baseDir, "../settings/Mainnet.toml");

    const raw = await fs.readFile(settingsPath, "utf8");
    const parsed = TOML.parse(raw) as NetworkSettings;

    const mnemonic = parsed?.accounts?.deployer?.mnemonic;
    if (!mnemonic || mnemonic.includes("<YOUR PRIVATE MAINNET MNEMONIC HERE>")) {
        throw new Error(
            `Mnemonic not found in ${settingsPath}. Please set [accounts.deployer].mnemonic.`
        );
    }
    return mnemonic.trim();
}

async function deriveSenderFromMnemonic(mnemonic: string) {
    const wallet = await generateWallet({
        secretKey: mnemonic,
        password: "",
    });
    const account = wallet.accounts[0];

    function normalizeSenderKey(key: string): string {
        let k = (key || "").trim();
        if (k.startsWith("0x") || k.startsWith("0X")) k = k.slice(2);
        return k;
    }

    const rawKey = account.stxPrivateKey || "";
    const senderKey = normalizeSenderKey(rawKey);

    const senderAddress = getStxAddress({
        account,
        transactionVersion: TransactionVersion.Mainnet,
    });

    console.log(
        `Derived sender key length: ${senderKey.length} hex chars (address: ${senderAddress})`
    );

    return { senderKey, senderAddress };
}

function pickRandomDelayMs(): number {
    const i = Math.floor(Math.random() * DELAY_CHOICES_MS.length);
    return DELAY_CHOICES_MS[i];
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        if (signal?.aborted) {
            clearTimeout(timer);
            return reject(new Error("aborted"));
        }
        signal?.addEventListener("abort", onAbort);
    });
}

async function readCounter(network: any, senderAddress: string) {
    const res = await fetchCallReadOnlyFunction({
        contractAddress: CONTRACT_ADDRESS,
        contractName: CONTRACT_NAME,
        functionName: FN_GET_COUNTER,
        functionArgs: [],
        network,
        senderAddress,
    });
    return cvToString(res);
}

async function readProposal(
    network: any,
    senderAddress: string,
    proposalId: number
) {
    const res = await fetchCallReadOnlyFunction({
        contractAddress: CONTRACT_ADDRESS,
        contractName: CONTRACT_NAME,
        functionName: FN_GET_PROPOSAL,
        functionArgs: [uintCV(proposalId)],
        network,
        senderAddress,
    });
    return cvToString(res);
}

async function readProposalCount(network: any, senderAddress: string) {
    const res = await fetchCallReadOnlyFunction({
        contractAddress: CONTRACT_ADDRESS,
        contractName: CONTRACT_NAME,
        functionName: FN_GET_PROPOSAL_COUNT,
        functionArgs: [],
        network,
        senderAddress,
    });
    return cvToString(res);
}

async function contractCall(
    network: any,
    senderKey: string,
    functionName: string,
    functionArgs: any[] = []
) {
    console.log(
        `Preparing contract-call tx for: ${functionName}${functionArgs.length > 0 ? " with args" : ""
        }`
    );
    const tx = await makeContractCall({
        contractAddress: CONTRACT_ADDRESS,
        contractName: CONTRACT_NAME,
        functionName,
        functionArgs,
        network,
        senderKey,
        fee: DEFAULT_FEE_USTX,
        anchorMode: AnchorMode.Any,
        postConditionMode: PostConditionMode.Allow,
    });

    try {
        const resp = await broadcastTransaction({ transaction: tx, network });
        const txid = (resp as any).txid || (resp as any).transactionId || "unknown-txid";
        console.log(`Broadcast response for ${functionName}: ${txid}`);
        return txid;
    } catch (e: any) {
        const reason = e?.message || "unknown-error";
        throw new Error(`Broadcast failed for ${functionName}: ${reason}`);
    }
}

async function runCounterMode(
    network: any,
    senderKey: string,
    senderAddress: string,
    stopSignal: AbortSignal
) {
    console.log("Running in COUNTER mode: incrementing counter");
    let keepRunning = true;
    while (keepRunning) {
        const waitMs = pickRandomDelayMs();
        console.log(`Waiting ${waitMs}ms...`);
        try { await delay(waitMs, stopSignal); } catch { break; }

        try {
            const txid = await contractCall(network, senderKey, FN_INCREMENT);
            console.log(`Txid: ${txid}`);
            const val = await readCounter(network, senderAddress);
            console.log(`New Counter: ${val}`);
        } catch (e) {
            console.error(`Error: ${(e as Error).message}`);
        }
    }
}

async function runDecrementMode(
    network: any,
    senderKey: string,
    senderAddress: string,
    stopSignal: AbortSignal
) {
    console.log("Running in DECREMENT mode: decrementing counter");
    let keepRunning = true;
    while (keepRunning) {
        const waitMs = pickRandomDelayMs();
        console.log(`Waiting ${waitMs}ms...`);
        try { await delay(waitMs, stopSignal); } catch { break; }

        try {
            const txid = await contractCall(network, senderKey, FN_DECREMENT);
            console.log(`Txid: ${txid}`);
            const val = await readCounter(network, senderAddress);
            console.log(`New Counter: ${val}`);
        } catch (e) {
            console.error(`Error: ${(e as Error).message}`);
        }
    }
}

async function runProposeMode(
    network: any,
    senderKey: string,
    senderAddress: string,
    stopSignal: AbortSignal
) {
    console.log("Running in PROPOSE mode: creating proposals");
    let keepRunning = true;
    while (keepRunning) {
        const waitMs = pickRandomDelayMs();
        console.log(`Waiting ${waitMs}ms...`);
        try { await delay(waitMs, stopSignal); } catch { break; }

        const title = `Prop ${Math.floor(Math.random() * 1000)}`;
        const desc = "Automated proposal from driver script";
        try {
            const txid = await contractCall(network, senderKey, FN_CREATE_PROPOSAL, [
                stringAsciiCV(title),
                stringUtf8CV(desc),
            ]);
            console.log(`Proposed ${title}, Txid: ${txid}`);
            const count = await readProposalCount(network, senderAddress);
            console.log(`Total Proposals: ${count}`);
        } catch (e) {
            console.error(`Error: ${(e as Error).message}`);
        }
    }
}

async function runVoteMode(
    network: any,
    senderKey: string,
    senderAddress: string,
    stopSignal: AbortSignal
) {
    console.log("Running in VOTE mode");
    let keepRunning = true;
    while (keepRunning) {
        const waitMs = pickRandomDelayMs();
        console.log(`Waiting ${waitMs}ms...`);
        try { await delay(waitMs, stopSignal); } catch { break; }

        try {
            const countStr = await readProposalCount(network, senderAddress);
            const count = parseInt(countStr.replace(/\D/g, "")) || 0;
            if (count === 0) {
                console.log("No proposals to vote on.");
                continue;
            }
            const propId = Math.floor(Math.random() * count);
            const voteFor = Math.random() > 0.5;
            const amount = 1;
            const txid = await contractCall(network, senderKey, FN_VOTE, [
                uintCV(propId),
                boolCV(voteFor),
                uintCV(amount)
            ]);
            console.log(`Voted ${voteFor ? "FOR" : "AGAINST"} prop ${propId}, Txid: ${txid}`);
        } catch (e) {
            console.error(`Error: ${(e as Error).message}`);
        }
    }
}

async function runExecuteMode(
    network: any,
    senderKey: string,
    senderAddress: string,
    stopSignal: AbortSignal
) {
    console.log("Running in EXECUTE mode");
    let keepRunning = true;
    while (keepRunning) {
        const waitMs = pickRandomDelayMs();
        console.log(`Waiting ${waitMs}ms...`);
        try { await delay(waitMs, stopSignal); } catch { break; }

        try {
            const countStr = await readProposalCount(network, senderAddress);
            const count = parseInt(countStr.replace(/\D/g, "")) || 0;
            if (count === 0) {
                console.log("No proposals to execute.");
                continue;
            }
            const propId = count - 1; // Try executing the latest one
            const txid = await contractCall(network, senderKey, FN_EXECUTE_PROPOSAL, [uintCV(propId)]);
            console.log(`Executed prop ${propId}, Txid: ${txid}`);
        } catch (e) {
            console.error(`Error: ${(e as Error).message}`);
        }
    }
}

async function runFullMode(
    network: any,
    senderKey: string,
    senderAddress: string,
    stopSignal: AbortSignal
) {
    console.log("Running in FULL mode: cycling through actions");
    const modes = ["increment", "propose", "vote", "execute"];
    let i = 0;
    while (!stopSignal.aborted) {
        const currentMode = modes[i % modes.length];
        console.log(`\n--- Action: ${currentMode} ---`);
        if (currentMode === "increment") {
            try { await contractCall(network, senderKey, FN_INCREMENT); } catch (e) { }
        } else if (currentMode === "propose") {
            try { await contractCall(network, senderKey, FN_CREATE_PROPOSAL, [stringAsciiCV("DAO Upgrade"), stringUtf8CV("Full flow test")]); } catch (e) { }
        } else if (currentMode === "vote") {
            try {
                const countStr = await readProposalCount(network, senderAddress);
                const count = parseInt(countStr.replace(/\D/g, "")) || 0;
                if (count > 0) await contractCall(network, senderKey, FN_VOTE, [uintCV(count - 1), boolCV(true), uintCV(10)]);
            } catch (e) { }
        } else if (currentMode === "execute") {
            try {
                const countStr = await readProposalCount(network, senderAddress);
                const count = parseInt(countStr.replace(/\D/g, "")) || 0;
                if (count > 0) await contractCall(network, senderKey, FN_EXECUTE_PROPOSAL, [uintCV(count - 1)]);
            } catch (e) { }
        }
        i++;
        const waitMs = pickRandomDelayMs();
        console.log(`Waiting ${waitMs}ms for next phase...`);
        try { await delay(waitMs, stopSignal); } catch { break; }
    }
}

async function main() {
    console.log("BitGov driver starting...");
    const network = createNetwork("mainnet");

    try {
        const mnemonic = await readMainnetMnemonic();
        const { senderKey, senderAddress } = await deriveSenderFromMnemonic(mnemonic);

        const stopController = new AbortController();
        process.on("SIGINT", () => {
            console.log("\nStopping...");
            stopController.abort();
        });

        if (MODE === "counter") await runCounterMode(network, senderKey, senderAddress, stopController.signal);
        else if (MODE === "decrement") await runDecrementMode(network, senderKey, senderAddress, stopController.signal);
        else if (MODE === "propose") await runProposeMode(network, senderKey, senderAddress, stopController.signal);
        else if (MODE === "vote") await runVoteMode(network, senderKey, senderAddress, stopController.signal);
        else if (MODE === "execute") await runExecuteMode(network, senderKey, senderAddress, stopController.signal);
        else if (MODE === "full") await runFullMode(network, senderKey, senderAddress, stopController.signal);
        else console.error("Unknown mode.");

    } catch (e) {
        console.error(`Fatal: ${(e as Error).message}`);
    }
}

main().catch(console.error);
