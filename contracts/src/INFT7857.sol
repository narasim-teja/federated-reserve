// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title INFT7857
/// @notice Minimal ERC-7857 ("intelligent NFT") skeleton. Phase 3 deploys and
///         tests this; Phase 5 actually mints one per deep state-agent with
///         the agent's encrypted-metadata URI on 0G Storage.
///
///         ERC-7857 extends ERC-721 with `metadataURI` (encrypted, off-chain)
///         and a `transferIntelligence` flow that re-encrypts metadata for
///         the new owner. This skeleton implements the storage hook only —
///         the re-encryption ceremony lives off-chain in 0G's TEE flow and
///         is recorded here via `setMetadataURI`.
contract INFT7857 is ERC721, Ownable {
    /// tokenId -> encrypted metadata URI on 0G Storage.
    mapping(uint256 => string) private _metadataURIs;

    event MetadataURIUpdated(uint256 indexed tokenId, string uri);

    constructor(address owner_) ERC721("Federated Reserve Agent iNFT", "FR-iNFT") Ownable(owner_) {}

    function mint(address to, uint256 tokenId, string calldata metadataURI_) external onlyOwner {
        _safeMint(to, tokenId);
        _metadataURIs[tokenId] = metadataURI_;
        emit MetadataURIUpdated(tokenId, metadataURI_);
    }

    /// Owner of the token (or contract admin) updates the encrypted metadata
    /// URI — used by the re-encryption ceremony when ownership transfers.
    function setMetadataURI(uint256 tokenId, string calldata uri) external {
        address tokenOwner = _ownerOf(tokenId);
        require(tokenOwner != address(0), "nonexistent token");
        require(msg.sender == tokenOwner || msg.sender == owner(), "not authorized");
        _metadataURIs[tokenId] = uri;
        emit MetadataURIUpdated(tokenId, uri);
    }

    function metadataURI(uint256 tokenId) external view returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "nonexistent token");
        return _metadataURIs[tokenId];
    }
}
