// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Federated Reserve Phase 0 Hello-World ERC-721 (0G testnet)
/// @notice Minimal ERC-721-shaped contract used only to prove the 0G chain
///         is responsive and our deployer wallet can broadcast a tx. Phase 5
///         replaces this with the real ERC-7857 INFT contract.
contract HelloNFT {
    string public name = "FederatedReserveHelloNFT";
    string public symbol = "FRHN";

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function mint(address to) external returns (uint256 tokenId) {
        require(to != address(0), "to=0");
        tokenId = totalSupply++;
        ownerOf[tokenId] = to;
        balanceOf[to] += 1;
        emit Transfer(address(0), to, tokenId);
    }
}
