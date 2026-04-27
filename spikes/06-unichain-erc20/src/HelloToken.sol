// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Federated Reserve Phase 0 Hello-World ERC-20 (Unichain Sepolia)
/// @notice Minimal ERC-20-shaped contract used only to prove the Unichain
///         Sepolia RPC accepts contract deploys. Phase 3 replaces this with
///         the real per-state StateToken contracts.
contract HelloToken {
    string public name = "FederatedReserveHello";
    string public symbol = "FRH";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply) {
        totalSupply = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "insufficient");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }
}
