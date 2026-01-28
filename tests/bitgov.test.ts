
import { describe, expect, it } from "vitest";
import { Cl } from "@stacks/transactions";

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
        expect(result).toBeOk(Cl.uint(1));

        // Check value
        const check = simnet.callReadOnlyFn("bitgov", "get-general-counter", [], deployer);
        expect(check.result).toBeUint(1);
    });

    it("decrements correctly", () => {
        // Setup: set to 1
        simnet.callPublicFn("bitgov", "increment", [], deployer);

        const { result } = simnet.callPublicFn("bitgov", "decrement", [], deployer);
        expect(result).toBeOk(Cl.uint(0));
    });

    it("fails to decrement below 0", () => {
        const { result } = simnet.callPublicFn("bitgov", "decrement", [], deployer);
        expect(result).toBeErr(Cl.uint(109)); // Underflow error
    });
});

describe("BitGov Governance Logic", () => {
    // Initial setup for membership
    it("initializes dao and adds deployer", () => {
        const { result } = simnet.callPublicFn("bitgov", "initialize-dao", [], deployer);
        expect(result).toBeOk(Cl.bool(true));

        const memberInfo = simnet.callReadOnlyFn("bitgov", "get-member-info", [Cl.standardPrincipal(deployer)], deployer);
        expect(memberInfo.result).toBeSome();
    });

    it("creates a proposal", () => {
        // Must be initialized from previous test or re-run here. Simnet persists in 'describe' usually?
        // Let's re-init to be safe or rely on persistence. Vitest-clarity resets usually.
        simnet.callPublicFn("bitgov", "initialize-dao", [], deployer);

        const title = "Test Proposal";
        const description = "Testing proposal creation";

        const { result } = simnet.callPublicFn(
            "bitgov",
            "create-proposal",
            [
                Cl.stringAscii(title),
                Cl.stringUtf8(description),
                Cl.uint(0), // transfer-amount
                Cl.none(),  // transfer-to
                Cl.none()   // add-member
            ],
            deployer
        );

        expect(result).toBeOk(Cl.uint(0)); // First ID is u0

        const proposal = simnet.callReadOnlyFn("bitgov", "get-proposal", [Cl.uint(0)], deployer);
        const resJson = JSON.stringify(proposal.result);
        expect(resJson).toContain(`"value":"${title}"`);
        expect(resJson).toContain('"value":"active"');
    });

    it("allows voting with reputation", () => {
        simnet.callPublicFn("bitgov", "initialize-dao", [], deployer);
        simnet.callPublicFn("bitgov", "create-proposal", [Cl.stringAscii("Vote Test"), Cl.stringUtf8("Desc"), Cl.uint(0), Cl.none(), Cl.none()], deployer);

        // Deployer has 100 reputation from initialize-dao
        const { result } = simnet.callPublicFn(
            "bitgov",
            "vote",
            [Cl.uint(0), Cl.bool(true)],
            deployer
        );

        expect(result).toBeOk(Cl.bool(true));

        // Check vote recorded
        const proposal = simnet.callReadOnlyFn("bitgov", "get-proposal", [Cl.uint(0)], deployer);
        const resJson = JSON.stringify(proposal.result);
        // votes-for should be 100
        expect(resJson).toContain('"votes-for":{"type":"uint","value":"100"}');
    });

    it("fails voting if not a member", () => {
        simnet.callPublicFn("bitgov", "initialize-dao", [], deployer);
        simnet.callPublicFn("bitgov", "create-proposal", [Cl.stringAscii("Vote Test"), Cl.stringUtf8("Desc"), Cl.uint(0), Cl.none(), Cl.none()], deployer);

        // Voter1 is not a member yet
        const { result } = simnet.callPublicFn(
            "bitgov",
            "vote",
            [Cl.uint(0), Cl.bool(true)],
            voter1
        );
        expect(result).toBeErr(Cl.uint(109)); // ERR_NOT_MEMBER
    });

    it("executes a treasury proposal", () => {
        simnet.callPublicFn("bitgov", "initialize-dao", [], deployer);

        // Fund treasury
        simnet.callPublicFn("bitgov", "deposit", [Cl.uint(1000)], deployer);

        // Create spend proposal
        simnet.callPublicFn("bitgov", "create-proposal",
            [
                Cl.stringAscii("Spend"),
                Cl.stringUtf8("Desc"),
                Cl.uint(500),
                Cl.some(Cl.standardPrincipal(voter1)),
                Cl.none()
            ],
            deployer
        );

        // Vote pass
        simnet.callPublicFn("bitgov", "vote", [Cl.uint(0), Cl.bool(true)], deployer);

        // Mine blocks
        simnet.mineEmptyBlocks(145);

        const { result } = simnet.callPublicFn("bitgov", "execute-proposal", [Cl.uint(0)], deployer);
        expect(result).toBeOk(Cl.bool(true));

        // Check balance of voter1 (simnet doesn't easily show STX balance of standard principals, 
        // but we can check if treasury decreased?)
        const treasury = simnet.callReadOnlyFn("bitgov", "get-treasury-balance", [], deployer);
        expect(treasury.result).toBeUint(500); // 1000 - 500
    });

    it("executes a membership proposal", () => {
        simnet.callPublicFn("bitgov", "initialize-dao", [], deployer);

        // Create add-member proposal for voter1
        simnet.callPublicFn("bitgov", "create-proposal",
            [
                Cl.stringAscii("Add Member"),
                Cl.stringUtf8("Desc"),
                Cl.uint(0),
                Cl.none(),
                Cl.some(Cl.standardPrincipal(voter1))
            ],
            deployer
        );

        // Vote pass
        simnet.callPublicFn("bitgov", "vote", [Cl.uint(0), Cl.bool(true)], deployer);

        // Mine blocks
        simnet.mineEmptyBlocks(145);

        const execute = simnet.callPublicFn("bitgov", "execute-proposal", [Cl.uint(0)], deployer);
        expect(execute.result).toBeOk(Cl.bool(true));

        // Verify voter1 is member
        const memberInfo = simnet.callReadOnlyFn("bitgov", "get-member-info", [Cl.standardPrincipal(voter1)], deployer);
        expect(memberInfo.result).toBeSome();
    });
});
