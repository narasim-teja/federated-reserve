// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOracle} from "./IOracle.sol";

/// @title INFT7857 — ERC-7857 "intelligent NFT" implementation
/// @notice ERC-721 plus encrypted-metadata + sealed-key + oracle-verified
///         re-encryption on transfer. One iNFT == one Federated Reserve
///         state-treasurer agent. Encrypted bundle (persona + persistent
///         memory) lives on 0G Storage; the on-chain token commits to it
///         via `metadataHash` and points at it via `encryptedURI`.
///
///         Dynamic-memory anchoring: as agents accumulate decisions and
///         their persistent memory evolves, the token *owner* uploads the
///         new encrypted snapshot to 0G Storage and calls
///         [`updateMetadata`](#updatemetadata) — every call emits
///         `MetadataUpdated`, giving the chainscan explorer a live record
///         of the agent thinking.
///
///         Reference: https://docs.0g.ai/developer-hub/building-on-0g/inft/erc7857
contract INFT7857 is ERC721, Ownable {
    /// Encrypted-bundle URI on 0G Storage (typically `0g://<rootHash>`).
    mapping(uint256 => string) private _encryptedURIs;
    /// keccak256(plaintext bundle) — commitment binding the URI to its content.
    mapping(uint256 => bytes32) private _metadataHashes;
    /// Symmetric encryption key sealed to the current owner's pubkey
    /// (AES-256-GCM key encrypted via ECIES, hex-encoded). Rotated by the
    /// oracle on transfer.
    mapping(uint256 => bytes) private _sealedKeys;
    /// Per-token, per-executor usage authorizations (opaque permission blob).
    mapping(uint256 => mapping(address => bytes)) private _authorizations;

    address public oracle;

    event MetadataUpdated(uint256 indexed tokenId, bytes32 newHash, string newURI);
    event SealedKeyUpdated(uint256 indexed tokenId, address indexed forOwner);
    event UsageAuthorized(uint256 indexed tokenId, address indexed executor);
    event UsageRevoked(uint256 indexed tokenId, address indexed executor);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event Cloned(uint256 indexed sourceTokenId, uint256 indexed newTokenId, address indexed to);

    error NotTokenOwner();
    error TokenDoesNotExist();
    error OracleNotSet();
    error InvalidProof();
    error AlreadyMinted();

    constructor(address owner_, address oracle_)
        ERC721("Federated Reserve Agent iNFT", "FR-iNFT")
        Ownable(owner_)
    {
        oracle = oracle_;
        emit OracleUpdated(address(0), oracle_);
    }

    // -------------------------------------------------------------------- //
    // Admin                                                                //
    // -------------------------------------------------------------------- //

    /// Replace the oracle (admin-only). Use during testnet upgrades — production
    /// would freeze this once a real TEE/ZK verifier is in place.
    function setOracle(address newOracle) external onlyOwner {
        address old = oracle;
        oracle = newOracle;
        emit OracleUpdated(old, newOracle);
    }

    /// Initial mint — only the contract admin can mint a fresh agent.
    /// `sealedKey` MUST be the AES-256-GCM key for the encrypted bundle,
    /// sealed to `to`'s pubkey (ECIES). `metadataHash` is keccak256 of the
    /// plaintext bundle.
    function mint(
        address to,
        uint256 tokenId,
        string calldata encryptedURI_,
        bytes32 metadataHash_,
        bytes calldata sealedKey_
    ) external onlyOwner {
        if (_ownerOf(tokenId) != address(0)) revert AlreadyMinted();
        _safeMint(to, tokenId);
        _encryptedURIs[tokenId] = encryptedURI_;
        _metadataHashes[tokenId] = metadataHash_;
        _sealedKeys[tokenId] = sealedKey_;
        emit MetadataUpdated(tokenId, metadataHash_, encryptedURI_);
        emit SealedKeyUpdated(tokenId, to);
    }

    // -------------------------------------------------------------------- //
    // Dynamic-memory anchor                                                //
    // -------------------------------------------------------------------- //

    /// Token owner anchors a new encrypted memory snapshot. Called by the
    /// agent's runtime each time a material state change should be made
    /// publicly verifiable on chain.
    function updateMetadata(uint256 tokenId, string calldata newURI, bytes32 newHash) external {
        address tokenOwner = _ownerOf(tokenId);
        if (tokenOwner == address(0)) revert TokenDoesNotExist();
        if (msg.sender != tokenOwner && msg.sender != owner()) revert NotTokenOwner();
        _encryptedURIs[tokenId] = newURI;
        _metadataHashes[tokenId] = newHash;
        emit MetadataUpdated(tokenId, newHash, newURI);
    }

    // -------------------------------------------------------------------- //
    // ERC-7857 transfer / clone                                            //
    // -------------------------------------------------------------------- //

    /// ERC-7857 ownership transfer with re-encryption.
    ///
    /// The off-chain ceremony (TEE or ZK) decrypts the bundle under the old
    /// owner's key, re-encrypts the symmetric key for `to`, and emits a
    /// `proof` binding `(oldHash, newHash, newSealedKey)`. The oracle
    /// verifies that proof; on success this contract rotates the stored
    /// sealedKey and metadata hash and re-points the token.
    function transfer(
        address from,
        address to,
        uint256 tokenId,
        bytes calldata newSealedKey,
        bytes calldata proof
    ) external {
        if (oracle == address(0)) revert OracleNotSet();
        address tokenOwner = _ownerOf(tokenId);
        if (tokenOwner == address(0)) revert TokenDoesNotExist();
        if (tokenOwner != from) revert NotTokenOwner();
        if (msg.sender != from && msg.sender != owner() && !isApprovedForAll(from, msg.sender)) {
            revert NotTokenOwner();
        }
        bytes32 newHash = IOracle(oracle).verifyProof(proof);
        if (newHash == bytes32(0)) revert InvalidProof();

        _sealedKeys[tokenId] = newSealedKey;
        _metadataHashes[tokenId] = newHash;
        _safeTransfer(from, to, tokenId);
        emit MetadataUpdated(tokenId, newHash, _encryptedURIs[tokenId]);
        emit SealedKeyUpdated(tokenId, to);
    }

    /// ERC-7857 clone — mint a derived token with re-encrypted metadata.
    function clone(address to, uint256 tokenId, bytes calldata newSealedKey, bytes calldata proof)
        external
        returns (uint256 newTokenId)
    {
        if (oracle == address(0)) revert OracleNotSet();
        address tokenOwner = _ownerOf(tokenId);
        if (tokenOwner == address(0)) revert TokenDoesNotExist();
        if (msg.sender != tokenOwner && msg.sender != owner()) revert NotTokenOwner();
        bytes32 newHash = IOracle(oracle).verifyProof(proof);
        if (newHash == bytes32(0)) revert InvalidProof();

        // Derive a deterministic new id (collision-resistant within practical use).
        newTokenId = uint256(keccak256(abi.encode(tokenId, to, block.number, msg.sender)));
        _safeMint(to, newTokenId);
        _encryptedURIs[newTokenId] = _encryptedURIs[tokenId];
        _metadataHashes[newTokenId] = newHash;
        _sealedKeys[newTokenId] = newSealedKey;
        emit Cloned(tokenId, newTokenId, to);
        emit MetadataUpdated(newTokenId, newHash, _encryptedURIs[newTokenId]);
        emit SealedKeyUpdated(newTokenId, to);
    }

    // -------------------------------------------------------------------- //
    // Usage authorization                                                   //
    // -------------------------------------------------------------------- //

    function authorizeUsage(uint256 tokenId, address executor, bytes calldata permissions) external {
        address tokenOwner = _ownerOf(tokenId);
        if (tokenOwner == address(0)) revert TokenDoesNotExist();
        if (msg.sender != tokenOwner) revert NotTokenOwner();
        _authorizations[tokenId][executor] = permissions;
        emit UsageAuthorized(tokenId, executor);
    }

    function revokeUsage(uint256 tokenId, address executor) external {
        address tokenOwner = _ownerOf(tokenId);
        if (tokenOwner == address(0)) revert TokenDoesNotExist();
        if (msg.sender != tokenOwner) revert NotTokenOwner();
        delete _authorizations[tokenId][executor];
        emit UsageRevoked(tokenId, executor);
    }

    function authorizationOf(uint256 tokenId, address executor) external view returns (bytes memory) {
        return _authorizations[tokenId][executor];
    }

    // -------------------------------------------------------------------- //
    // Views                                                                 //
    // -------------------------------------------------------------------- //

    function encryptedURI(uint256 tokenId) external view returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        return _encryptedURIs[tokenId];
    }

    function metadataHash(uint256 tokenId) external view returns (bytes32) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        return _metadataHashes[tokenId];
    }

    function sealedKey(uint256 tokenId) external view returns (bytes memory) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        return _sealedKeys[tokenId];
    }
}
