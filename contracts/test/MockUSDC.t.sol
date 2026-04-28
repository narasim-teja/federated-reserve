// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract MockUSDCTest is Test {
    MockUSDC usdc;
    address alice = address(0xA1);

    function setUp() public {
        usdc = new MockUSDC();
    }

    function test_decimals_is_six() public view {
        assertEq(usdc.decimals(), 6);
    }

    function test_anyone_can_mint() public {
        vm.prank(alice);
        usdc.mint(alice, 1_000_000); // 1 USDC
        assertEq(usdc.balanceOf(alice), 1_000_000);
    }

    function test_transfer_works() public {
        usdc.mint(address(this), 5_000_000);
        usdc.transfer(alice, 2_000_000);
        assertEq(usdc.balanceOf(alice), 2_000_000);
    }
}
