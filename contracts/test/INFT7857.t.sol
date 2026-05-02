// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {INFT7857} from "../src/INFT7857.sol";
import {MockOracle} from "../src/MockOracle.sol";

contract INFT7857Test is Test {
    INFT7857 inft;
    MockOracle oracle;

    address admin = address(0xA);
    address agent = address(0xB);
    address newOwner = address(0xC);
    address attacker = address(0xDEAD);

    bytes32 constant H1 = keccak256("bundle-v1");
    bytes32 constant H2 = keccak256("bundle-v2");
    bytes constant SEALED_KEY_1 = hex"AABBCCDD";
    bytes constant SEALED_KEY_2 = hex"11223344";

    function setUp() public {
        oracle = new MockOracle();
        inft = new INFT7857(admin, address(oracle));
    }

    function _proofFor(bytes32 h) internal pure returns (bytes memory) {
        return abi.encodePacked(h);
    }

    function test_constructor_sets_oracle() public view {
        assertEq(inft.oracle(), address(oracle));
    }

    function test_mint_records_metadata_and_sealed_key() public {
        vm.prank(admin);
        inft.mint(agent, 1, "0g://root-1", H1, SEALED_KEY_1);
        assertEq(inft.ownerOf(1), agent);
        assertEq(inft.encryptedURI(1), "0g://root-1");
        assertEq(inft.metadataHash(1), H1);
        assertEq(inft.sealedKey(1), SEALED_KEY_1);
    }

    function test_double_mint_reverts() public {
        vm.startPrank(admin);
        inft.mint(agent, 1, "0g://root-1", H1, SEALED_KEY_1);
        vm.expectRevert(INFT7857.AlreadyMinted.selector);
        inft.mint(agent, 1, "0g://other", H2, SEALED_KEY_2);
        vm.stopPrank();
    }

    function test_owner_can_anchor_new_memory_snapshot() public {
        vm.prank(admin);
        inft.mint(agent, 1, "0g://root-1", H1, SEALED_KEY_1);
        vm.prank(agent);
        inft.updateMetadata(1, "0g://root-2", H2);
        assertEq(inft.encryptedURI(1), "0g://root-2");
        assertEq(inft.metadataHash(1), H2);
    }

    function test_third_party_cannot_anchor() public {
        vm.prank(admin);
        inft.mint(agent, 1, "0g://root-1", H1, SEALED_KEY_1);
        vm.prank(attacker);
        vm.expectRevert(INFT7857.NotTokenOwner.selector);
        inft.updateMetadata(1, "0g://hostile", H2);
    }

    function test_transfer_via_oracle_proof_rotates_key_and_owner() public {
        vm.prank(admin);
        inft.mint(agent, 1, "0g://root-1", H1, SEALED_KEY_1);

        vm.prank(agent);
        inft.transfer(agent, newOwner, 1, SEALED_KEY_2, _proofFor(H2));

        assertEq(inft.ownerOf(1), newOwner);
        assertEq(inft.sealedKey(1), SEALED_KEY_2);
        assertEq(inft.metadataHash(1), H2);
        assertEq(inft.encryptedURI(1), "0g://root-1");
    }

    function test_transfer_with_zero_proof_reverts() public {
        vm.prank(admin);
        inft.mint(agent, 1, "0g://root-1", H1, SEALED_KEY_1);

        vm.prank(agent);
        vm.expectRevert(INFT7857.InvalidProof.selector);
        inft.transfer(agent, newOwner, 1, SEALED_KEY_2, _proofFor(bytes32(0)));
    }

    function test_clone_mints_derived_token() public {
        vm.prank(admin);
        inft.mint(agent, 1, "0g://root-1", H1, SEALED_KEY_1);

        vm.prank(agent);
        uint256 newId = inft.clone(newOwner, 1, SEALED_KEY_2, _proofFor(H2));

        assertEq(inft.ownerOf(newId), newOwner);
        assertEq(inft.metadataHash(newId), H2);
        assertEq(inft.sealedKey(newId), SEALED_KEY_2);
        assertEq(inft.encryptedURI(newId), "0g://root-1");
        // Original is untouched.
        assertEq(inft.ownerOf(1), agent);
        assertEq(inft.metadataHash(1), H1);
    }

    function test_authorize_and_revoke_usage() public {
        vm.prank(admin);
        inft.mint(agent, 1, "0g://root-1", H1, SEALED_KEY_1);

        bytes memory perms = hex"01";
        vm.prank(agent);
        inft.authorizeUsage(1, attacker, perms);
        assertEq(inft.authorizationOf(1, attacker), perms);

        vm.prank(agent);
        inft.revokeUsage(1, attacker);
        assertEq(inft.authorizationOf(1, attacker), hex"");
    }

    function test_admin_can_replace_oracle() public {
        MockOracle other = new MockOracle();
        vm.prank(admin);
        inft.setOracle(address(other));
        assertEq(inft.oracle(), address(other));
    }
}
