// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StateToken} from "../src/StateToken.sol";

contract StateTokenTest is Test {
    StateToken token;
    address treasury = address(0x7);
    address bob = address(0xB);

    uint256 constant INITIAL = 1_000_000 ether; // 1M tokens, 18 decimals

    function setUp() public {
        token = new StateToken("Massachusetts Treasury Token", "MAT", 25, treasury, INITIAL);
    }

    function test_metadata() public view {
        assertEq(token.name(), "Massachusetts Treasury Token");
        assertEq(token.symbol(), "MAT");
        assertEq(token.decimals(), 18);
        assertEq(token.fips(), 25);
        assertEq(token.owner(), treasury);
    }

    function test_initial_mint_to_owner() public view {
        assertEq(token.totalSupply(), INITIAL);
        assertEq(token.balanceOf(treasury), INITIAL);
    }

    function test_owner_can_mint_more() public {
        vm.prank(treasury);
        token.mint(bob, 100 ether);
        assertEq(token.balanceOf(bob), 100 ether);
        assertEq(token.totalSupply(), INITIAL + 100 ether);
    }

    function test_non_owner_cannot_mint() public {
        vm.prank(bob);
        vm.expectRevert();
        token.mint(bob, 100 ether);
    }
}
