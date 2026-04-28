// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title StateToken
/// @notice Per-state ERC-20 representing locally-issued exposure to a US
///         state's economy. Used as the "give" or "receive" leg of bilateral
///         swaps in Phase 3, paired with MockUSDC in Uniswap pools.
///
///         The owner (the state's treasury wallet) can mint additional supply
///         to issue secondary offerings. 18 decimals to match common ERC-20
///         tooling — USDC is the 6-decimal outlier.
contract StateToken is ERC20, Ownable {
    /// FIPS code of the issuing state (e.g. 25 = MA, 6 = CA).
    uint16 public immutable fips;

    constructor(
        string memory name_,
        string memory symbol_,
        uint16 fips_,
        address owner_,
        uint256 initialSupply
    ) ERC20(name_, symbol_) Ownable(owner_) {
        fips = fips_;
        _mint(owner_, initialSupply);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
