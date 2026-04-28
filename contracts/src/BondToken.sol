// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title BondToken
/// @notice One contract per bond issuance. Issuer mints to the winning bidder
///         on `bond-auction.awarded`; the bidder transfers MockUSDC equal to
///         `principal` to the issuer atomically (off-chain orchestration via
///         A2A, on-chain settlement is two ERC-20 calls).
///
///         Coupon and maturity are recorded on-chain for auditability; this
///         Phase 3 build does not yet enforce coupon payments — that is a
///         Phase 4+ economic primitive.
contract BondToken is ERC20 {
    address public immutable issuer;
    uint16 public immutable issuerFips;
    /// Coupon rate in basis points (e.g. 425 = 4.25%).
    uint16 public immutable couponBps;
    /// Unix seconds at which the principal repays.
    uint64 public immutable maturity;
    /// Total principal in MockUSDC base units (6 decimals).
    uint256 public immutable principal;
    /// Stable id supplied by the issuer for auction reconciliation.
    string public bondId;

    error OnlyIssuer();

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert OnlyIssuer();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        string memory bondId_,
        address issuer_,
        uint16 issuerFips_,
        uint16 couponBps_,
        uint64 maturity_,
        uint256 principal_
    ) ERC20(name_, symbol_) {
        bondId = bondId_;
        issuer = issuer_;
        issuerFips = issuerFips_;
        couponBps = couponBps_;
        maturity = maturity_;
        principal = principal_;
    }

    /// Issuer mints the principal amount to the awarded bidder once the
    /// bidder's USDC transfer has been confirmed (caller responsibility).
    function mint(address to, uint256 amount) external onlyIssuer {
        _mint(to, amount);
    }
}
