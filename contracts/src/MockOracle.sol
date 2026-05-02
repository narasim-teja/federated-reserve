// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IOracle} from "./IOracle.sol";

/// @title MockOracle
/// @notice Hackathon-grade oracle that trusts the caller to embed a 32-byte
///         metadata hash as the leading word of `proof`. Production deployments
///         swap this for a TEE-attestation verifier or ZK verifier.
///
///         The encoding is intentionally minimal: `proof = abi.encodePacked(
///         newMetadataHash)` (≥32 bytes; trailing bytes ignored).
contract MockOracle is IOracle {
    function verifyProof(bytes calldata proof) external pure returns (bytes32 newMetadataHash) {
        require(proof.length >= 32, "MockOracle: proof too short");
        // Decode the first 32 bytes as the new metadata hash.
        bytes32 h;
        assembly {
            h := calldataload(proof.offset)
        }
        return h;
    }
}
