// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {INFT7857} from "../src/INFT7857.sol";

contract INFT7857Test is Test {
    INFT7857 inft;
    address admin = address(0xA);
    address agent = address(0xB);

    function setUp() public {
        inft = new INFT7857(admin);
    }

    function test_mint_records_metadata() public {
        vm.prank(admin);
        inft.mint(agent, 1, "0g://CID-encrypted-blob-1");
        assertEq(inft.ownerOf(1), agent);
        assertEq(inft.metadataURI(1), "0g://CID-encrypted-blob-1");
    }

    function test_owner_can_update_metadata() public {
        vm.prank(admin);
        inft.mint(agent, 1, "0g://old-uri");
        vm.prank(agent);
        inft.setMetadataURI(1, "0g://new-uri-after-reflect");
        assertEq(inft.metadataURI(1), "0g://new-uri-after-reflect");
    }

    function test_third_party_cannot_update_metadata() public {
        vm.prank(admin);
        inft.mint(agent, 1, "0g://x");
        vm.prank(address(0xDEAD));
        vm.expectRevert();
        inft.setMetadataURI(1, "0g://hostile");
    }
}
