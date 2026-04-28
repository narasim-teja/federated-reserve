// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BondToken} from "../src/BondToken.sol";

contract BondTokenTest is Test {
    BondToken bond;
    address issuer = address(0x111);
    address bidder = address(0x222);

    uint16 constant FIPS = 25;
    uint16 constant COUPON_BPS = 425; // 4.25%
    uint64 constant MATURITY = 1893456000; // 2030-01-01
    uint256 constant PRINCIPAL = 1_000_000 * 1e6; // 1M USDC

    function setUp() public {
        bond = new BondToken(
            "MA 4.25% 2030 Bond",
            "MAB30",
            "MA-2030-Q1-A",
            issuer,
            FIPS,
            COUPON_BPS,
            MATURITY,
            PRINCIPAL
        );
    }

    function test_metadata_is_recorded() public view {
        assertEq(bond.issuer(), issuer);
        assertEq(bond.issuerFips(), FIPS);
        assertEq(bond.couponBps(), COUPON_BPS);
        assertEq(bond.maturity(), MATURITY);
        assertEq(bond.principal(), PRINCIPAL);
        assertEq(bond.bondId(), "MA-2030-Q1-A");
    }

    function test_issuer_can_mint() public {
        vm.prank(issuer);
        bond.mint(bidder, PRINCIPAL);
        assertEq(bond.balanceOf(bidder), PRINCIPAL);
    }

    function test_non_issuer_cannot_mint() public {
        vm.prank(bidder);
        vm.expectRevert(BondToken.OnlyIssuer.selector);
        bond.mint(bidder, PRINCIPAL);
    }
}
