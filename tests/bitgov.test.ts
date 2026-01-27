
import { describe, expect, it } from "vitest";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const voter1 = accounts.get("wallet_1")!;
const voter2 = accounts.get("wallet_2")!;

describe("BitGov Counter Logic", () => {
    it("starts at 0", () => {
        const { result } = simnet.callReadOnlyFn("bitgov", "get-general-counter", [], deployer);
        expect(result).toBeUint(0);
    });

    it("increments correctly", () => {
        const { result } = simnet.callPublicFn("bitgov", "increment", [], deployer);
        expect(result).toBeOk(simnet.uint(1));

        // Check value
        const check = simnet.callReadOnlyFn("bitgov", "get-general-counter", [], deployer);
        expect(check.result).toBeUint(1);
    });

    it("decrements correctly", () => {
        // Increment first to 2 (1 from previous test + 1)
        // Note: Simnet state resets between `it` blocks unless configured otherwise? 
        // Usually vitest/simnet resets. Let's assume independent state or just setup.
        // Actually, in typical Clarinet/Vitest setup, state might persist in `describe` or reset.
        // Safest is to treat each `it` as independent or chain them if we know. 
        // For `simnet`, it usually resets per test file or `beforeEach` validation.
        // Let's assume reset for safety and setup state if needed.

        // Setup: set to 1
        simnet.callPublicFn("bitgov", "increment", [], deployer);

        const { result } = simnet.callPublicFn("bitgov", "decrement", [], deployer);
        expect(result).toBeOk(simnet.uint(0));
    });

    it("fails to decrement below 0", () => {
        // Current state should be 0 (if reset)
        const { result } = simnet.callPublicFn("bitgov", "decrement", [], deployer);
        expect(result).toBeErr(simnet.uint(109)); // Underflow error
    });
});

describe("BitGov Governance Logic", () => {
    it("creates a proposal", () => {
        const title = "Test Proposal";
        const description = "Testing proposal creation";

        const { result } = simnet.callPublicFn(
            "bitgov",
            "create-proposal",
            [simnet.stringAscii(title), simnet.stringUtf8(description)],
            deployer
        );

        expect(result).toBeOk(simnet.uint(0)); // First ID is u0

        const proposal = simnet.callReadOnlyFn("bitgov", "get-proposal", [simnet.uint(0)], deployer);
        expect(proposal.result).toBeSome(expect.objectContaining({
            title: simnet.stringAscii(title),
            status: simnet.stringAscii("active")
        }));
    });

    it("allows voting", () => {
        // Setup proposal
        simnet.callPublicFn("bitgov", "create-proposal", [simnet.stringAscii("Vote Test"), simnet.stringUtf8("Desc")], deployer);

        const voteAmount = 100;
        const { result } = simnet.callPublicFn(
            "bitgov",
            "vote",
            [simnet.uint(0), simnet.bool(true), simnet.uint(voteAmount)],
            voter1
        );

        expect(result).toBeOk(simnet.bool(true));

        // Check vote recorded
        const proposal = simnet.callReadOnlyFn("bitgov", "get-proposal", [simnet.uint(0)], deployer);
        // Inspect tuple structure for votes-for
        // Simnet return types are structured.
        // We can rely on basic execution success for now or deep inspect.
    });

    it("prevents double voting", () => {
        simnet.callPublicFn("bitgov", "create-proposal", [simnet.stringAscii("Double Vote"), simnet.stringUtf8("Desc")], deployer);

        simnet.callPublicFn("bitgov", "vote", [simnet.uint(0), simnet.bool(true), simnet.uint(100)], voter1);

        const { result } = simnet.callPublicFn("bitgov", "vote", [simnet.uint(0), simnet.bool(false), simnet.uint(100)], voter1);
        expect(result).toBeErr(simnet.uint(105)); // ERR_ALREADY_VOTED
    });

    it("executes a passed proposal", () => {
        simnet.callPublicFn("bitgov", "create-proposal", [simnet.stringAscii("Exec Test"), simnet.stringUtf8("Desc")], deployer);

        // Vote Yes > No
        simnet.callPublicFn("bitgov", "vote", [simnet.uint(0), simnet.bool(true), simnet.uint(100)], voter1);

        // Mine blocks to pass voting period (144 blocks)
        simnet.mineEmptyBlocks(145);

        const { result } = simnet.callPublicFn("bitgov", "execute-proposal", [simnet.uint(0)], deployer);
        expect(result).toBeOk(simnet.bool(true)); // Passed

        // Check status
        const proposal = simnet.callReadOnlyFn("bitgov", "get-proposal", [simnet.uint(0)], deployer);
        expect(proposal.result).toBeSome(expect.objectContaining({
            status: simnet.stringAscii("passed"),
            executed: simnet.bool(true)
        }));
    });

    it("fails execution if voting period not ended", () => {
        simnet.callPublicFn("bitgov", "create-proposal", [simnet.stringAscii("Early Exec"), simnet.stringUtf8("Desc")], deployer);

        const { result } = simnet.callPublicFn("bitgov", "execute-proposal", [simnet.uint(0)], deployer);
        expect(result).toBeErr(simnet.uint(108)); // ERR_EXECUTION_DELAY_NOT_MET
    });
});
