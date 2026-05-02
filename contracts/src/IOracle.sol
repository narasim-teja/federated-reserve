// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IOracle — ERC-7857 verifier interface
/// @notice The oracle attests that an off-chain re-encryption ceremony was
///         performed correctly. In production this is a TEE attestation or a
///         ZK proof verifier; for hackathon testnet we ship a mock that always
///         returns true (see [MockOracle](./MockOracle.sol)).
interface IOracle {
    /// Verify a proof binding (oldMetadataHash, newMetadataHash, sealedKey).
    /// Returns the new metadata hash so callers don't have to re-parse the proof.
    function verifyProof(bytes calldata proof) external view returns (bytes32 newMetadataHash);
}
